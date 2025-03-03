import { connect } from "cloudflare:sockets";

/**
 * 多提供商AI API兼容代理
 * 支持OpenAI、Anthropic、Gemini API
 * 自动检测模型类型路由到相应API
 * 实现多API密钥负载均衡
 * 智能字符流式输出优化
 * 支持Web管理界面
 * 使用ShadowFetch替换Cloudflare Fetch
 */

// ShadowFetch 实现 - 从 shadowfetch.js 移植
// -------------- Begin ShadowFetch implementation --------------

// Define text encoder and decoder for converting between strings and byte arrays
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Filter out HTTP headers that should not be forwarded
const HEADER_FILTER_RE = /^(host|accept-encoding|cf-)/i;

// Define the debug log output function
const log = (message, data = "") => console.log(`[DEBUG] ${message}`, data);

// Concatenate multiple Uint8Arrays into a single new Uint8Array
function concatUint8Arrays(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Parse HTTP response headers
function parseHttpHeaders(buff) {
  const text = decoder.decode(buff);
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerSection = text.slice(0, headerEnd).split("\r\n");
  const statusLine = headerSection[0];
  const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
  if (!statusMatch) throw new Error(`Invalid status line: ${statusLine}`);
  const headers = new Headers();
  for (let i = 1; i < headerSection.length; i++) {
    const line = headerSection[i];
    const idx = line.indexOf(": ");
    if (idx !== -1) {
      headers.append(line.slice(0, idx), line.slice(idx + 2));
    }
  }
  return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
}

// Read data from the reader until a double CRLF is encountered
async function readUntilDoubleCRLF(reader) {
  let respText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      respText += decoder.decode(value, { stream: true });
      if (respText.includes("\r\n\r\n")) break;
    }
    if (done) break;
  }
  return respText;
}

// Async generator: read chunked HTTP response data chunks
async function* readChunks(reader, buff = new Uint8Array()) {
  while (true) {
    let pos = -1;
    for (let i = 0; i < buff.length - 1; i++) {
      if (buff[i] === 13 && buff[i + 1] === 10) {
        pos = i;
        break;
      }
    }
    if (pos === -1) {
      const { value, done } = await reader.read();
      if (done) break;
      buff = concatUint8Arrays(buff, value);
      continue;
    }
    const size = parseInt(decoder.decode(buff.slice(0, pos)), 16);
    log("Read chunk size", size);
    if (!size) break;
    buff = buff.slice(pos + 2);
    while (buff.length < size + 2) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Unexpected EOF in chunked encoding");
      buff = concatUint8Arrays(buff, value);
    }
    yield buff.slice(0, size);
    buff = buff.slice(size + 2);
  }
}

// Parse the complete HTTP response
async function parseResponse(reader) {
  let buff = new Uint8Array();
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buff = concatUint8Arrays(buff, value);
      const parsed = parseHttpHeaders(buff);
      if (parsed) {
        const { status, statusText, headers, headerEnd } = parsed;
        const isChunked = headers.get("transfer-encoding")?.includes("chunked");
        const contentLength = parseInt(headers.get("content-length") || "0", 10);
        const data = buff.slice(headerEnd + 4);
        return new Response(
          new ReadableStream({
            async start(ctrl) {
              try {
                if (isChunked) {
                  log("Using chunked transfer mode");
                  for await (const chunk of readChunks(reader, data)) {
                    ctrl.enqueue(chunk);
                  }
                } else {
                  log("Using fixed-length transfer mode", { contentLength });
                  let received = data.length;
                  if (data.length) ctrl.enqueue(data);
                  while (received < contentLength) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    received += value.length;
                    ctrl.enqueue(value);
                  }
                }
                ctrl.close();
              } catch (err) {
                log("Error parsing response", err);
                ctrl.error(err);
              }
            },
          }),
          { status, statusText, headers }
        );
      }
    }
    if (done) break;
  }
  throw new Error("Unable to parse response headers");
}

// Generate a random Sec-WebSocket-Key
function generateWebSocketKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

// Pack a text message into a WebSocket frame
function packTextFrame(payload) {
  const FIN_AND_OP = 0x81;
  const maskBit = 0x80;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = new Uint8Array(2);
    header[0] = FIN_AND_OP;
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = new Uint8Array(4);
    header[0] = FIN_AND_OP;
    header[1] = maskBit | 126;
    header[2] = (len >> 8) & 0xff;
    header[3] = len & 0xff;
  } else {
    throw new Error("Payload too large");
  }
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  const maskedPayload = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payload[i] ^ mask[i % 4];
  }
  return concatUint8Arrays(header, mask, maskedPayload);
}

// Class for parsing and reassembling WebSocket frames
class SocketFramesReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array();
    this.fragmentedPayload = null;
    this.fragmentedOpcode = null;
  }
  
  async ensureBuffer(length) {
    while (this.buffer.length < length) {
      const { value, done } = await this.reader.read();
      if (done) return false;
      this.buffer = concatUint8Arrays(this.buffer, value);
    }
    return true;
  }
  
  async nextFrame() {
    while (true) {
      if (!(await this.ensureBuffer(2))) return null;
      const first = this.buffer[0],
        second = this.buffer[1],
        fin = (first >> 7) & 1,
        opcode = first & 0x0f,
        isMasked = (second >> 7) & 1;
      let payloadLen = second & 0x7f,
        offset = 2;
      if (payloadLen === 126) {
        if (!(await this.ensureBuffer(offset + 2))) return null;
        payloadLen = (this.buffer[offset] << 8) | this.buffer[offset + 1];
        offset += 2;
      } else if (payloadLen === 127) {
        throw new Error("127 length mode is not supported");
      }
      let mask;
      if (isMasked) {
        if (!(await this.ensureBuffer(offset + 4))) return null;
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (!(await this.ensureBuffer(offset + payloadLen))) return null;
      let payload = this.buffer.slice(offset, offset + payloadLen);
      if (isMasked && mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }
      this.buffer = this.buffer.slice(offset + payloadLen);
      if (opcode === 0) {
        if (this.fragmentedPayload === null)
          throw new Error("Received continuation frame without initiation");
        this.fragmentedPayload = concatUint8Arrays(this.fragmentedPayload, payload);
        if (fin) {
          const completePayload = this.fragmentedPayload;
          const completeOpcode = this.fragmentedOpcode;
          this.fragmentedPayload = this.fragmentedOpcode = null;
          return { fin: true, opcode: completeOpcode, payload: completePayload };
        }
      } else {
        if (!fin) {
          this.fragmentedPayload = payload;
          this.fragmentedOpcode = opcode;
          continue;
        } else {
          if (this.fragmentedPayload) {
            this.fragmentedPayload = this.fragmentedOpcode = null;
          }
          return { fin, opcode, payload };
        }
      }
    }
  }
}

// Forward HTTP requests or WebSocket handshake and data
async function nativeFetch(req, dstUrl) {
  const cleanedHeaders = new Headers();
  for (const [k, v] of req.headers) {
    if (!HEADER_FILTER_RE.test(k)) {
      cleanedHeaders.set(k, v);
    }
  }
  
  const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
  const isWebSocket = upgradeHeader === "websocket";
  const targetUrl = new URL(dstUrl);
  
  if (isWebSocket) {
    if (!/^wss?:\/\//i.test(dstUrl)) {
      return new Response("Target does not support WebSocket", { status: 400 });
    }
    const isSecure = targetUrl.protocol === "wss:";
    const port = targetUrl.port || (isSecure ? 443 : 80);
    const socket = await connect(
      { hostname: targetUrl.hostname, port: Number(port) },
      { secureTransport: isSecure ? "on" : "off" }
    );
  
    const key = generateWebSocketKey();
    cleanedHeaders.set('Host', targetUrl.hostname);
    cleanedHeaders.set('Connection', 'Upgrade');
    cleanedHeaders.set('Upgrade', 'websocket');
    cleanedHeaders.set('Sec-WebSocket-Version', '13');
    cleanedHeaders.set('Sec-WebSocket-Key', key);
  
    const handshakeReq =
      `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(cleanedHeaders.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n';

    log("Sending WebSocket handshake request", handshakeReq);
    const writer = socket.writable.getWriter();
    await writer.write(encoder.encode(handshakeReq));
  
    const reader = socket.readable.getReader();
    const handshakeResp = await readUntilDoubleCRLF(reader);
    log("Received handshake response", handshakeResp);
    if (
      !handshakeResp.includes("101") ||
      !handshakeResp.includes("Switching Protocols")
    ) {
      throw new Error("WebSocket handshake failed: " + handshakeResp);
    }
  
    const [client, server] = new WebSocketPair();
    client.accept();
    relayWebSocketFrames(client, socket, writer, reader);
    return new Response(null, { status: 101, webSocket: server });
  } else {
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    const port = targetUrl.protocol === "https:" ? 443 : 80;
    const socket = await connect(
      { hostname: targetUrl.hostname, port },
      { secureTransport: targetUrl.protocol === "https:" ? "on" : "off" }
    );
    const writer = socket.writable.getWriter();
    const requestLine =
      `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(cleanedHeaders.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n";
    log("Sending request", requestLine);
    await writer.write(encoder.encode(requestLine));
  
    if (req.body) {
      log("Forwarding request body");
      for await (const chunk of req.body) {
        await writer.write(chunk);
      }
    }
    return await parseResponse(socket.readable.getReader());
  }
}

// Relay WebSocket frames bidirectionally
function relayWebSocketFrames(ws, socket, writer, reader) {
  ws.addEventListener("message", async (event) => {
    let payload;
    if (typeof event.data === "string") {
      payload = encoder.encode(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      payload = new Uint8Array(event.data);
    } else {
      payload = event.data;
    }
    const frame = packTextFrame(payload);
    try {
      await writer.write(frame);
    } catch (e) {
      log("Remote write error", e);
    }
  });
  
  (async function relayFrames() {
    const frameReader = new SocketFramesReader(reader);
    try {
      while (true) {
        const frame = await frameReader.nextFrame();
        if (!frame) break;
        switch (frame.opcode) {
          case 1: // Text frame
          case 2: // Binary frame
            ws.send(frame.payload);
            break;
          case 8: // Close frame
            log("Received Close frame, closing WebSocket");
            ws.close(1000);
            return;
          default:
            log(`Received unknown frame type, Opcode: ${frame.opcode}`);
        }
      }
    } catch (e) {
      log("Error reading remote frame", e);
    } finally {
      ws.close();
      writer.releaseLock();
      socket.close();
    }
  })();
  
  ws.addEventListener("close", () => socket.close());
}

// 实现一个与原生fetch兼容的接口，内部使用nativeFetch
async function shadowFetch(urlOrRequest, init = {}) {
  let request;
  let url;
  
  if (urlOrRequest instanceof Request) {
    request = urlOrRequest;
    url = request.url;
  } else {
    url = urlOrRequest;
    request = new Request(url, init);
  }
  
  return await nativeFetch(request, url);
}

// -------------- End ShadowFetch implementation --------------

// KV配置键名
const KV_CONFIG_KEYS = {
  UPSTREAM_URL: "upstream_url",
  OUTGOING_API_KEY: "outgoing_api_key",
  GEMINI_URL: "gemini_url",
  GEMINI_API_KEY: "gemini_api_key",
  ANTHROPIC_URL: "anthropic_url",
  ANTHROPIC_API_KEY: "anthropic_api_key",
  PROXY_API_KEY: "proxy_api_key",
  // 字符延迟参数
  MIN_DELAY: "min_delay",
  MAX_DELAY: "max_delay",
  ADAPTIVE_DELAY_FACTOR: "adaptive_delay_factor",
  CHUNK_BUFFER_SIZE: "chunk_buffer_size"
};

// 默认配置
const DEFAULT_CONFIG = {
  // 字符间延迟参数
  minDelay: 5,              // 最小延迟(毫秒)
  maxDelay: 40,             // 最大延迟(毫秒)
  adaptiveDelayFactor: 0.8, // 自适应延迟因子
  chunkBufferSize: 8,       // 计算平均响应大小的缓冲区大小
};

// 预定义模型前缀映射到API类型
const MODEL_PREFIX_MAP = {
  'claude': 'anthropic',
  'gemini': 'gemini'
};

// Worker入口函数
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 添加根目录重定向到/admin
    if (url.pathname === '/' || url.pathname === '') {
      return Response.redirect(`${url.origin}/admin`, 302);
    }
    
    // 检查是否是管理页面请求
    if (url.pathname.startsWith('/admin')) {
      return handleAdminRequest(request, env, ctx);
    }

    // 处理API请求
    // 从KV读取配置
    const config = await loadConfigFromKV(env);
    
    return handleRequest(request, config);
  },
};

// 从KV存储加载配置
async function loadConfigFromKV(env) {
  // 检查是否有KV绑定
  if (!env.CONFIG_KV) {
    console.log("未检测到KV绑定,使用环境变量作为配置");
    return getDefaultConfig(env);
  }

  try {
    // 准备配置对象
    const config = { ...DEFAULT_CONFIG };
    
    // 尝试从KV加载各个配置项
    const promises = Object.entries(KV_CONFIG_KEYS).map(async ([configName, kvKey]) => {
      const value = await env.CONFIG_KV.get(kvKey);
      if (value !== null) {
        // 根据配置项类型设置值
        switch (configName) {
          case "MIN_DELAY":
            config.minDelay = parseInt(value) || DEFAULT_CONFIG.minDelay;
            break;
          case "MAX_DELAY":
            config.maxDelay = parseInt(value) || DEFAULT_CONFIG.maxDelay;
            break;
          case "ADAPTIVE_DELAY_FACTOR":
            config.adaptiveDelayFactor = parseFloat(value) || DEFAULT_CONFIG.adaptiveDelayFactor;
            break;
          case "CHUNK_BUFFER_SIZE":
            config.chunkBufferSize = parseInt(value) || DEFAULT_CONFIG.chunkBufferSize;
            break;
          case "UPSTREAM_URL":
            config.defaultUpstreamUrl = value;
            break;
          case "OUTGOING_API_KEY":
            config.defaultOutgoingApiKey = value;
            break;
          case "GEMINI_URL":
            config.geminiUpstreamUrl = value;
            break;
          case "GEMINI_API_KEY":
            config.geminiApiKey = value;
            config.geminiEnabled = !!value;
            break;
          case "ANTHROPIC_URL":
            config.anthropicUpstreamUrl = value;
            break;
          case "ANTHROPIC_API_KEY":
            config.anthropicApiKey = value;
            config.anthropicEnabled = !!value;
            break;
          case "PROXY_API_KEY":
            config.proxyApiKey = value;
            break;
        }
      }
    });
    
    // 等待所有KV读取完成
    await Promise.all(promises);
    
    // 如果KV中没有某些配置,则使用环境变量作为后备
    config.defaultUpstreamUrl = config.defaultUpstreamUrl || env.UPSTREAM_URL || "https://api.openai.com";
    config.defaultOutgoingApiKey = config.defaultOutgoingApiKey || env.OUTGOING_API_KEY || "";
    
    config.geminiUpstreamUrl = config.geminiUpstreamUrl || env.GEMINI_URL || "https://generativelanguage.googleapis.com";
    config.geminiApiKey = config.geminiApiKey || env.GEMINI_API_KEY || "";
    config.geminiEnabled = config.geminiEnabled || !!env.GEMINI_API_KEY;
    
    config.anthropicUpstreamUrl = config.anthropicUpstreamUrl || env.ANTHROPIC_URL || "https://api.anthropic.com";
    config.anthropicApiKey = config.anthropicApiKey || env.ANTHROPIC_API_KEY || "";
    config.anthropicEnabled = config.anthropicEnabled || !!env.ANTHROPIC_API_KEY;
    
    config.proxyApiKey = config.proxyApiKey || env.PROXY_API_KEY || "";
    
    return config;
  } catch (error) {
    console.error("从KV加载配置时出错:", error);
    // 发生错误时使用环境变量作为后备
    return getDefaultConfig(env);
  }
}

// 使用环境变量获取默认配置
function getDefaultConfig(env) {
  return {
    ...DEFAULT_CONFIG,
    // OpenAI配置
    defaultUpstreamUrl: env.UPSTREAM_URL || "https://api.openai.com",
    defaultOutgoingApiKey: env.OUTGOING_API_KEY || "",
    
    // Gemini配置
    geminiEnabled: !!env.GEMINI_API_KEY,
    geminiUpstreamUrl: env.GEMINI_URL || "https://generativelanguage.googleapis.com",
    geminiApiKey: env.GEMINI_API_KEY || "",
    
    // Anthropic配置
    anthropicEnabled: !!env.ANTHROPIC_API_KEY,
    anthropicUpstreamUrl: env.ANTHROPIC_URL || "https://api.anthropic.com",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    
    // 代理控制配置
    proxyApiKey: env.PROXY_API_KEY || "",  // 代理服务自身的API密钥
  };
}

// 将配置保存到KV存储
async function saveConfigToKV(env, config) {
  if (!env.CONFIG_KV) {
    return { success: false, message: "未检测到KV绑定,无法保存配置" };
  }

  try {
    // 保存配置到KV
    const promises = [
      env.CONFIG_KV.put(KV_CONFIG_KEYS.UPSTREAM_URL, config.defaultUpstreamUrl || ""),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.OUTGOING_API_KEY, config.defaultOutgoingApiKey || ""),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.GEMINI_URL, config.geminiUpstreamUrl || ""),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.GEMINI_API_KEY, config.geminiApiKey || ""),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.ANTHROPIC_URL, config.anthropicUpstreamUrl || ""),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.ANTHROPIC_API_KEY, config.anthropicApiKey || ""),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.PROXY_API_KEY, config.proxyApiKey || ""),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.MIN_DELAY, config.minDelay.toString()),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.MAX_DELAY, config.maxDelay.toString()),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.ADAPTIVE_DELAY_FACTOR, config.adaptiveDelayFactor.toString()),
      env.CONFIG_KV.put(KV_CONFIG_KEYS.CHUNK_BUFFER_SIZE, config.chunkBufferSize.toString())
    ];
    
    await Promise.all(promises);
    return { success: true, message: "配置保存成功" };
  } catch (error) {
    console.error("保存配置到KV时出错:", error);
    return { success: false, message: `配置保存失败: ${error.message}` };
  }
}

// 处理管理页面请求
async function handleAdminRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 提供登录页面
  if (path === '/admin' || path === '/admin/') {
    return serveLoginPage();
  }
  
  // 处理API请求
  if (path === '/admin/api/login') {
    return handleLoginRequest(request, env);
  }
  
  if (path === '/admin/api/config') {
    return handleConfigApiRequest(request, env);
  }
  
  // 检查是否有有效的会话令牌
  const isLoggedIn = await checkAdminSession(request, env);
  
  if (path === '/admin/dashboard') {
    // 如果已登录,提供仪表盘
    if (isLoggedIn) {
      return serveDashboardPage();
    } else {
      // 未登录,重定向到登录页面
      return Response.redirect(`${url.origin}/admin`, 302);
    }
  }
  
  // 默认返回404
  return new Response("Not Found", { status: 404 });
}

// 检查管理员会话是否有效
async function checkAdminSession(request, env) {
  try {
    // 从Cookie中获取会话令牌
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const sessionToken = cookies.admin_session;
    
    if (!sessionToken) {
      return false;
    }
    
    // 验证会话令牌
    const config = await loadConfigFromKV(env);
    const expectedToken = await sha256(config.proxyApiKey || "");
    
    return sessionToken === expectedToken;
  } catch (error) {
    console.error("验证管理员会话时出错:", error);
    return false;
  }
}

// 处理登录请求
async function handleLoginRequest(request, env) {
  try {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ success: false, message: "方法不允许" }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 解析请求体
    const body = await request.json();
    const password = body.password;
    
    if (!password) {
      return new Response(JSON.stringify({ success: false, message: "密码不能为空" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 验证密码
    const config = await loadConfigFromKV(env);
    
    if (!config.proxyApiKey || password !== config.proxyApiKey) {
      return new Response(JSON.stringify({ success: false, message: "密码错误" }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 生成会话令牌(使用密码的哈希作为会话令牌)
    const sessionToken = await sha256(config.proxyApiKey);
    
    // 返回成功并设置Cookie
    return new Response(JSON.stringify({ success: true, message: "登录成功" }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `admin_session=${sessionToken}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=86400`
      }
    });
  } catch (error) {
    console.error("处理登录请求时出错:", error);
    return new Response(JSON.stringify({ success: false, message: `登录失败: ${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 处理配置API请求
async function handleConfigApiRequest(request, env) {
  try {
    // 验证管理员会话
    const isLoggedIn = await checkAdminSession(request, env);
    
    if (!isLoggedIn) {
      return new Response(JSON.stringify({ success: false, message: "未授权" }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 获取当前配置
    if (request.method === 'GET') {
      const config = await loadConfigFromKV(env);
      
      // 过滤敏感信息
      const safeConfig = {
        defaultUpstreamUrl: config.defaultUpstreamUrl,
        defaultOutgoingApiKey: maskAPIKey(config.defaultOutgoingApiKey),
        geminiEnabled: config.geminiEnabled,
        geminiUpstreamUrl: config.geminiUpstreamUrl,
        geminiApiKey: maskAPIKey(config.geminiApiKey),
        anthropicEnabled: config.anthropicEnabled,
        anthropicUpstreamUrl: config.anthropicUpstreamUrl,
        anthropicApiKey: maskAPIKey(config.anthropicApiKey),
        proxyApiKey: maskAPIKey(config.proxyApiKey),
        minDelay: config.minDelay,
        maxDelay: config.maxDelay,
        adaptiveDelayFactor: config.adaptiveDelayFactor,
        chunkBufferSize: config.chunkBufferSize
      };
      
      return new Response(JSON.stringify({ success: true, config: safeConfig }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 更新配置
    if (request.method === 'POST') {
      const body = await request.json();
      const currentConfig = await loadConfigFromKV(env);
      
      // 更新配置
      const newConfig = {
        ...currentConfig,
        defaultUpstreamUrl: body.defaultUpstreamUrl || currentConfig.defaultUpstreamUrl,
        geminiUpstreamUrl: body.geminiUpstreamUrl || currentConfig.geminiUpstreamUrl,
        anthropicUpstreamUrl: body.anthropicUpstreamUrl || currentConfig.anthropicUpstreamUrl,
        minDelay: parseInt(body.minDelay) || currentConfig.minDelay,
        maxDelay: parseInt(body.maxDelay) || currentConfig.maxDelay,
        adaptiveDelayFactor: parseFloat(body.adaptiveDelayFactor) || currentConfig.adaptiveDelayFactor,
        chunkBufferSize: parseInt(body.chunkBufferSize) || currentConfig.chunkBufferSize
      };
      
      // 仅更新非空API密钥(防止覆盖现有密钥)
      if (body.defaultOutgoingApiKey && !body.defaultOutgoingApiKey.includes('*')) {
        newConfig.defaultOutgoingApiKey = body.defaultOutgoingApiKey;
      }
      
      if (body.geminiApiKey && !body.geminiApiKey.includes('*')) {
        newConfig.geminiApiKey = body.geminiApiKey;
        newConfig.geminiEnabled = !!body.geminiApiKey;
      }
      
      if (body.anthropicApiKey && !body.anthropicApiKey.includes('*')) {
        newConfig.anthropicApiKey = body.anthropicApiKey;
        newConfig.anthropicEnabled = !!body.anthropicApiKey;
      }
      
      if (body.proxyApiKey && !body.proxyApiKey.includes('*')) {
        newConfig.proxyApiKey = body.proxyApiKey;
      }
      
      // 保存配置
      const result = await saveConfigToKV(env, newConfig);
      
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ success: false, message: "方法不允许" }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error("处理配置API请求时出错:", error);
    return new Response(JSON.stringify({ success: false, message: `操作失败: ${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 提供登录页面
function serveLoginPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>多功能API代理 - 管理登录</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
      body {
        background-color: #f8f9fa;
        font-family: 'Microsoft YaHei', sans-serif;
      }
      .login-container {
        max-width: 400px;
        margin: 100px auto;
        padding: 20px;
        background-color: #fff;
        border-radius: 5px;
        box-shadow: 0 0 10px rgba(0,0,0,0.1);
      }
      .login-title {
        text-align: center;
        margin-bottom: 30px;
        color: #333;
      }
      .login-btn {
        width: 100%;
      }
      .alert {
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="login-container">
        <h2 class="login-title">多功能API代理管理</h2>
        <div id="loginAlert" class="alert alert-danger mb-3" role="alert"></div>
        <form id="loginForm">
          <div class="mb-3">
            <label for="password" class="form-label">管理员密码</label>
            <input type="password" class="form-control" id="password" required>
            <div class="form-text">请输入代理API密钥作为管理员密码</div>
          </div>
          <button type="submit" class="btn btn-primary login-btn">登录</button>
        </form>
      </div>
    </div>
    
    <script>
      document.getElementById('loginForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const password = document.getElementById('password').value;
        const alertElement = document.getElementById('loginAlert');
        
        try {
          const response = await fetch('/admin/api/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
          });
          
          const data = await response.json();
          
          if (data.success) {
            // 登录成功,跳转到仪表盘
            window.location.href = '/admin/dashboard';
          } else {
            // 显示错误消息
            alertElement.textContent = data.message || '登录失败';
            alertElement.style.display = 'block';
          }
        } catch (error) {
          alertElement.textContent = '登录请求失败: ' + error.message;
          alertElement.style.display = 'block';
        }
      });
    </script>
  </body>
  </html>
  `;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
}

// 提供仪表盘页面
function serveDashboardPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>多功能API代理 - 管理仪表盘</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
      body {
        background-color: #f8f9fa;
        font-family: 'Microsoft YaHei', sans-serif;
        padding-bottom: 30px;
      }
      .dashboard-header {
        background-color: #fff;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        padding: 15px 0;
        margin-bottom: 30px;
      }
      .nav-tabs {
        margin-bottom: 20px;
      }
      .config-card {
        background-color: #fff;
        border-radius: 5px;
        box-shadow: 0 0 10px rgba(0,0,0,0.1);
        padding: 20px;
        margin-bottom: 20px;
      }
      .card-title {
        margin-bottom: 20px;
        color: #333;
        font-weight: 600;
      }
      .btn-save {
        min-width: 100px;
      }
      .status-badge {
        font-size: 85%;
      }
      .alert {
        display: none;
      }
    </style>
  </head>
  <body>
    <header class="dashboard-header">
      <div class="container">
        <div class="d-flex justify-content-between align-items-center">
          <h1 class="h3 mb-0">多功能API代理管理</h1>
          <button id="logoutBtn" class="btn btn-outline-secondary btn-sm">退出登录</button>
        </div>
      </div>
    </header>
    
    <div class="container">
      <div id="statusAlert" class="alert alert-dismissible fade show mb-4" role="alert">
        <span id="alertMessage"></span>
        <button type="button" class="btn-close" aria-label="Close" onclick="document.getElementById('statusAlert').style.display='none'"></button>
      </div>
      
      <ul class="nav nav-tabs" id="configTabs" role="tablist">
        <li class="nav-item" role="presentation">
          <button class="nav-link active" id="openai-tab" data-bs-toggle="tab" data-bs-target="#openai" type="button" role="tab" aria-controls="openai" aria-selected="true">OpenAI配置</button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" id="anthropic-tab" data-bs-toggle="tab" data-bs-target="#anthropic" type="button" role="tab" aria-controls="anthropic" aria-selected="false">Anthropic配置</button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" id="gemini-tab" data-bs-toggle="tab" data-bs-target="#gemini" type="button" role="tab" aria-controls="gemini" aria-selected="false">Gemini配置</button>
        </li>
        <li class="nav-item" role="presentation">
          <button class="nav-link" id="general-tab" data-bs-toggle="tab" data-bs-target="#general" type="button" role="tab" aria-controls="general" aria-selected="false">通用设置</button>
        </li>
      </ul>
      
      <div class="tab-content" id="configTabsContent">
        <!-- OpenAI配置 -->
        <div class="tab-pane fade show active" id="openai" role="tabpanel" aria-labelledby="openai-tab">
          <div class="config-card">
            <h5 class="card-title">OpenAI格式 API配置</h5>
            <form id="openaiForm">
              <div class="mb-3">
                <label for="defaultUpstreamUrl" class="form-label">API端点URL</label>
                <input type="url" class="form-control" id="defaultUpstreamUrl" placeholder="https://api.openai.com">
                <div class="form-text">OpenAI格式 API端点URL,默认为官方API</div>
              </div>
              <div class="mb-3">
                <label for="defaultOutgoingApiKey" class="form-label">API密钥</label>
                <input type="text" class="form-control" id="defaultOutgoingApiKey" placeholder="sk-...">
                <div class="form-text">可以设置多个API密钥,使用逗号分隔,系统会自动负载均衡</div>
              </div>
              <button type="submit" class="btn btn-primary btn-save">保存配置</button>
            </form>
          </div>
        </div>
        
        <!-- Anthropic配置 -->
        <div class="tab-pane fade" id="anthropic" role="tabpanel" aria-labelledby="anthropic-tab">
          <div class="config-card">
            <h5 class="card-title">
              Anthropic API配置
              <span id="anthropicStatus" class="badge rounded-pill ms-2 status-badge bg-secondary">未启用</span>
            </h5>
            <form id="anthropicForm">
              <div class="mb-3">
                <label for="anthropicUpstreamUrl" class="form-label">API端点URL</label>
                <input type="url" class="form-control" id="anthropicUpstreamUrl" placeholder="https://api.anthropic.com">
                <div class="form-text">Anthropic格式 API端点URL</div>
              </div>
              <div class="mb-3">
                <label for="anthropicApiKey" class="form-label">API密钥</label>
                <input type="text" class="form-control" id="anthropicApiKey" placeholder="sk-ant-...">
                <div class="form-text">可以设置多个API密钥,使用逗号分隔,系统会自动负载均衡</div>
              </div>
              <button type="submit" class="btn btn-primary btn-save">保存配置</button>
            </form>
          </div>
        </div>
        
        <!-- Gemini配置 -->
        <div class="tab-pane fade" id="gemini" role="tabpanel" aria-labelledby="gemini-tab">
          <div class="config-card">
            <h5 class="card-title">
              Gemini格式 API配置
              <span id="geminiStatus" class="badge rounded-pill ms-2 status-badge bg-secondary">未启用</span>
            </h5>
            <form id="geminiForm">
              <div class="mb-3">
                <label for="geminiUpstreamUrl" class="form-label">API端点URL</label>
                <input type="url" class="form-control" id="geminiUpstreamUrl" placeholder="https://generativelanguage.googleapis.com">
                <div class="form-text">Gemini API端点URL</div>
              </div>
              <div class="mb-3">
                <label for="geminiApiKey" class="form-label">API密钥</label>
                <input type="text" class="form-control" id="geminiApiKey" placeholder="AIzaSy...">
                <div class="form-text">可以设置多个API密钥,使用逗号分隔,系统会自动负载均衡</div>
              </div>
              <button type="submit" class="btn btn-primary btn-save">保存配置</button>
            </form>
          </div>
        </div>
        
        <!-- 通用设置 -->
        <div class="tab-pane fade" id="general" role="tabpanel" aria-labelledby="general-tab">
          <div class="config-card">
            <h5 class="card-title">代理设置</h5>
            <form id="proxyForm">
              <div class="mb-3">
                <label for="proxyApiKey" class="form-label">代理API密钥</label>
                <input type="text" class="form-control" id="proxyApiKey" placeholder="">
                <div class="form-text">客户端访问此代理时需要使用的API密钥,也是管理界面的登录密码</div>
              </div>
              <button type="submit" class="btn btn-primary btn-save">保存配置</button>
            </form>
          </div>
          
          <div class="config-card">
            <h5 class="card-title">流式输出优化</h5>
            <form id="streamForm">
              <div class="mb-3">
                <label for="minDelay" class="form-label">最小延迟(毫秒)</label>
                <input type="number" class="form-control" id="minDelay" min="0" max="100" step="1">
                <div class="form-text">字符间最小延迟时间,影响输出速度</div>
              </div>
              <div class="mb-3">
                <label for="maxDelay" class="form-label">最大延迟(毫秒)</label>
                <input type="number" class="form-control" id="maxDelay" min="1" max="500" step="1">
                <div class="form-text">字符间最大延迟时间,影响输出速度</div>
              </div>
              <div class="mb-3">
                <label for="adaptiveDelayFactor" class="form-label">自适应延迟因子</label>
                <input type="number" class="form-control" id="adaptiveDelayFactor" min="0" max="2" step="0.1">
                <div class="form-text">延迟自适应调整因子,值越大延迟变化越明显</div>
              </div>
              <div class="mb-3">
                <label for="chunkBufferSize" class="form-label">块缓冲区大小</label>
                <input type="number" class="form-control" id="chunkBufferSize" min="1" max="50" step="1">
                <div class="form-text">计算平均响应大小的缓冲区大小</div>
              </div>
              <button type="submit" class="btn btn-primary btn-save">保存配置</button>
            </form>
          </div>
        </div>
      </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js"></script>
    <script>
      // 加载配置
      async function loadConfig() {
        try {
          const response = await fetch('/admin/api/config');
          
          if (!response.ok) {
            if (response.status === 401) {
              // 未授权,跳转到登录页面
              window.location.href = '/admin';
              return;
            }
            throw new Error('获取配置失败: ' + response.status);
          }
          
          const data = await response.json();
          
          if (data.success) {
            // 填充表单
            const config = data.config;
            
            // OpenAI配置
            document.getElementById('defaultUpstreamUrl').value = config.defaultUpstreamUrl || '';
            document.getElementById('defaultOutgoingApiKey').value = config.defaultOutgoingApiKey || '';
            
            // Anthropic配置
            document.getElementById('anthropicUpstreamUrl').value = config.anthropicUpstreamUrl || '';
            document.getElementById('anthropicApiKey').value = config.anthropicApiKey || '';
            
            // 更新Anthropic状态徽章
            const anthropicStatus = document.getElementById('anthropicStatus');
            if (config.anthropicEnabled) {
              anthropicStatus.textContent = '已启用';
              anthropicStatus.classList.remove('bg-secondary');
              anthropicStatus.classList.add('bg-success');
            } else {
              anthropicStatus.textContent = '未启用';
              anthropicStatus.classList.remove('bg-success');
              anthropicStatus.classList.add('bg-secondary');
            }
            
            // Gemini配置
            document.getElementById('geminiUpstreamUrl').value = config.geminiUpstreamUrl || '';
            document.getElementById('geminiApiKey').value = config.geminiApiKey || '';
            
            // 更新Gemini状态徽章
            const geminiStatus = document.getElementById('geminiStatus');
            if (config.geminiEnabled) {
              geminiStatus.textContent = '已启用';
              geminiStatus.classList.remove('bg-secondary');
              geminiStatus.classList.add('bg-success');
            } else {
              geminiStatus.textContent = '未启用';
              geminiStatus.classList.remove('bg-success');
              geminiStatus.classList.add('bg-secondary');
            }
            
            // 代理设置
            document.getElementById('proxyApiKey').value = config.proxyApiKey || '';
            
            // 流式输出设置
            document.getElementById('minDelay').value = config.minDelay || 5;
            document.getElementById('maxDelay').value = config.maxDelay || 40;
            document.getElementById('adaptiveDelayFactor').value = config.adaptiveDelayFactor || 0.8;
            document.getElementById('chunkBufferSize').value = config.chunkBufferSize || 8;
          } else {
            showAlert('danger', data.message || '加载配置失败');
          }
        } catch (error) {
          showAlert('danger', '加载配置请求失败: ' + error.message);
        }
      }
      
      // 显示提示消息
      function showAlert(type, message) {
        const alertElement = document.getElementById('statusAlert');
        const messageElement = document.getElementById('alertMessage');
        
        alertElement.className = 'alert alert-' + type + ' alert-dismissible fade show mb-4';
        messageElement.textContent = message;
        alertElement.style.display = 'block';
        
        // 自动关闭
        setTimeout(() => {
          alertElement.style.display = 'none';
        }, 5000);
      }
      
      // 保存配置
      async function saveConfig(formData) {
        try {
          const response = await fetch('/admin/api/config', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
          });
          
          const data = await response.json();
          
          if (data.success) {
            showAlert('success', data.message || '配置保存成功');
            // 重新加载配置
            loadConfig();
          } else {
            showAlert('danger', data.message || '配置保存失败');
          }
        } catch (error) {
          showAlert('danger', '保存配置请求失败: ' + error.message);
        }
      }
      
      // 表单提交处理
      document.getElementById('openaiForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const formData = {
          defaultUpstreamUrl: document.getElementById('defaultUpstreamUrl').value,
          defaultOutgoingApiKey: document.getElementById('defaultOutgoingApiKey').value
        };
        saveConfig(formData);
      });
      
      document.getElementById('anthropicForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const formData = {
          anthropicUpstreamUrl: document.getElementById('anthropicUpstreamUrl').value,
          anthropicApiKey: document.getElementById('anthropicApiKey').value
        };
        saveConfig(formData);
      });
      
      document.getElementById('geminiForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const formData = {
          geminiUpstreamUrl: document.getElementById('geminiUpstreamUrl').value,
          geminiApiKey: document.getElementById('geminiApiKey').value
        };
        saveConfig(formData);
      });
      
      document.getElementById('proxyForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const formData = {
          proxyApiKey: document.getElementById('proxyApiKey').value
        };
        saveConfig(formData);
      });
      
      document.getElementById('streamForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const formData = {
          minDelay: document.getElementById('minDelay').value,
          maxDelay: document.getElementById('maxDelay').value,
          adaptiveDelayFactor: document.getElementById('adaptiveDelayFactor').value,
          chunkBufferSize: document.getElementById('chunkBufferSize').value
        };
        saveConfig(formData);
      });
      
      // 退出登录
      document.getElementById('logoutBtn').addEventListener('click', function() {
        // 清除Cookie
        document.cookie = 'admin_session=; Path=/admin; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
        // 跳转到登录页面
        window.location.href = '/admin';
      });
      
      // 页面加载时获取配置
      window.addEventListener('load', loadConfig);
    </script>
  </body>
  </html>
  `;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
}

// 解析Cookie
function parseCookies(cookieString) {
  const cookies = {};
  if (!cookieString) return cookies;
  
  cookieString.split(';').forEach(cookie => {
    const parts = cookie.trim().split('=');
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  });
  
  return cookies;
}

// 计算字符串的SHA-256哈希
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 遮盖API密钥,仅显示前几位和后几位
function maskAPIKey(apiKey) {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return apiKey;
  
  // 判断是否为多个API密钥
  if (apiKey.includes(',')) {
    // 处理多个API密钥
    return apiKey.split(',').map(key => maskAPIKey(key.trim())).join(', ');
  }
  
  // 根据密钥长度决定显示的字符数
  const visibleChars = Math.min(4, Math.floor(apiKey.length / 4));
  return apiKey.substring(0, visibleChars) + '*'.repeat(apiKey.length - visibleChars * 2) + apiKey.substring(apiKey.length - visibleChars);
}

// 主函数:处理所有API请求
async function handleRequest(request, config) {
  // 处理预检请求
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  try {
    // 验证代理API密钥
    if (!validateProxyApiKey(request, config)) {
      return new Response(JSON.stringify({
        error: {
          message: "Invalid API key or missing authentication",
          type: "auth_error",
          code: 401
        }
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 解析请求URL
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    
    // 检查是否为模型列表请求,如果是则特殊处理
    if (isModelsRequest(path)) {
      return await handleModelsRequest(request, config);
    }

    // 解析请求体和检查是否是流式请求
    const { requestBody, isStreamRequest } = await parseRequestBody(request);
    
    // 基于模型名称确定API提供商
    const apiType = determineApiType(requestBody.model, config);
    let upstreamRequest;
    
    if (apiType === 'anthropic' && config.anthropicEnabled) {
      upstreamRequest = await createAnthropicRequest(request, requestBody, config);
    } else if (apiType === 'gemini' && config.geminiEnabled) {
      upstreamRequest = await createGeminiRequest(request, requestBody, config);
    } else {
      // 默认使用OpenAI API
      const upstreamUrl = extractUpstreamUrl(request, config);
      const outgoingApiKey = extractOutgoingApiKey(request, config);
      
      upstreamRequest = createUpstreamRequest(
        `${upstreamUrl}${path}`, 
        request, 
        requestBody, 
        outgoingApiKey
      );
    }
    
    // 使用shadowFetch发送请求到上游API
    const upstreamResponse = await shadowFetch(upstreamRequest);
    
    // 如果不是流式请求或响应不成功,直接返回上游响应
    if (!isStreamRequest || !upstreamResponse.ok) {
      // 如果不是OpenAI API,需要转换响应格式
      if (apiType !== 'openai' && upstreamResponse.ok) {
        return await convertToOpenAIResponse(upstreamResponse, apiType, config);
      }
      return addCorsHeaders(upstreamResponse);
    }
    
    // 处理流式响应
    return handleStreamingResponse(upstreamResponse, apiType, config);
  } catch (error) {
    console.error("Error handling request:", error);
    return createErrorResponse(error);
  }
}

// 基于模型名称确定API类型
function determineApiType(modelName, config) {
  if (!modelName) return 'openai';
  
  modelName = modelName.toString().toLowerCase();
  
  // 检查模型前缀
  for (const [prefix, apiType] of Object.entries(MODEL_PREFIX_MAP)) {
    if (modelName.startsWith(prefix)) {
      // 只返回已启用的API类型
      if (apiType === 'anthropic' && config.anthropicEnabled) return 'anthropic';
      if (apiType === 'gemini' && config.geminiEnabled) return 'gemini';
    }
  }
  
  return 'openai';
}

// 统一处理模型列表请求
async function handleModelsRequest(request, config) {
  try {
    // 只获取已配置的提供商的模型列表
    const promises = [];
    
    // 始终获取OpenAI模型(如果配置了API密钥)
    if (config.defaultOutgoingApiKey) {
      promises.push(getOpenAIModels(request, config));
    }
    
    // 仅在启用时获取Gemini模型
    if (config.geminiEnabled) {
      promises.push(getGeminiModels(request, config));
    }
    
    // 仅在启用时获取Anthropic模型
    if (config.anthropicEnabled) {
      promises.push(getAnthropicModels(request, config));
    }
    
    // 等待所有模型列表获取完成
    const modelLists = await Promise.all(promises);
    
    // 合并所有模型列表
    const combinedModels = {
      object: "list",
      data: []
    };
    
    // 过滤掉无效结果并合并数据
    for (const list of modelLists) {
      if (list && list.data && Array.isArray(list.data)) {
        combinedModels.data = combinedModels.data.concat(list.data);
      }
    }
    
    return new Response(JSON.stringify(combinedModels), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Error handling models request:", error);
    return createErrorResponse(error);
  }
}

// 获取OpenAI模型列表
async function getOpenAIModels(request, config) {
  try {
    const upstreamUrl = extractUpstreamUrl(request, config);
    const outgoingApiKey = extractOutgoingApiKey(request, config);
    
    // 如果没有API密钥,则跳过
    if (!outgoingApiKey) return { object: "list", data: [] };
    
    const upstreamRequest = createUpstreamRequest(
      `${upstreamUrl}/v1/models`, 
      request, 
      {}, 
      outgoingApiKey
    );
    
    const response = await shadowFetch(upstreamRequest);
    if (!response.ok) return { object: "list", data: [] };
    
    const models = await response.json();
    
    // 添加提供商标签
    if (models && models.data) {
      models.data.forEach(model => {
        model.owned_by = model.owned_by || "openai";
      });
    }
    
    return models;
  } catch (error) {
    console.error("Error fetching OpenAI models:", error);
    return { object: "list", data: [] };
  }
}

// 获取Gemini模型列表
async function getGeminiModels(request, config) {
  try {
    const apiKey = getGeminiApiKey(request, config);
    
    // 如果没有API密钥,则跳过
    if (!apiKey) return { object: "list", data: [] };
    
    // 尝试从Gemini API获取模型列表
    try {
      // 请求Gemini模型API
      const modelListUrl = `${config.geminiUpstreamUrl}/v1beta/models?key=${apiKey}`;
      const response = await shadowFetch(modelListUrl);
      
      if (response.ok) {
        const geminiResponse = await response.json();
        
        // 将Gemini响应格式转换为OpenAI格式
        if (geminiResponse && geminiResponse.models) {
          return {
            object: "list",
            data: geminiResponse.models
              .filter(model => model.name.includes("gemini"))
              .map(model => ({
                id: model.name.split('/').pop(),  // 从路径中提取模型名称
                object: "model",
                created: Math.floor(Date.now() / 1000) - 86400 * 30, // 近似创建时间
                owned_by: "google"
              }))
          };
        }
      }
    } catch (e) {
      console.error("Error fetching Gemini models dynamically:", e);
    }
    
    // 如果API调用失败,使用更新后的静态列表
    return {
      object: "list",
      data: [
        {
          id: "gemini-pro",
          object: "model",
          created: 1686700000, // 近似时间戳
          owned_by: "google"
        },
        {
          id: "gemini-1.5-pro",
          object: "model",
          created: 1708000000, // 近似时间戳
          owned_by: "google"
        },
        {
          id: "gemini-1.5-flash",
          object: "model",
          created: 1708000000, // 近似时间戳
          owned_by: "google"
        },
        {
          id: "gemini-2.0-flash",
          object: "model",
          created: 1727000000, // 近似时间戳
          owned_by: "google"
        },
        {
          id: "gemini-2.0-pro-exp",
          object: "model",
          created: 1727000000, // 近似时间戳
          owned_by: "google"
        },
        {
          id: "gemini-2.0-flash-lite",
          object: "model",
          created: 1727000000, // 近似时间戳
          owned_by: "google"
        },
        {
          id: "gemini-2.0-flash-thinking-exp",
          object: "model",
          created: 1727000000, // 近似时间戳
          owned_by: "google"
        }
      ]
    };
  } catch (error) {
    console.error("Error creating Gemini models list:", error);
    return { object: "list", data: [] };
  }
}

// 获取Anthropic模型列表
async function getAnthropicModels(request, config) {
  try {
    const apiKey = getAnthropicApiKey(request, config);
    
    // 如果没有API密钥,则跳过
    if (!apiKey) return { object: "list", data: [] };
    
    // 尝试从Anthropic API获取模型列表
    try {
      const headers = new Headers();
      headers.set("x-api-key", apiKey);
      headers.set("anthropic-version", "2023-06-01");
      
      const response = await shadowFetch(`${config.anthropicUpstreamUrl}/v1/models`, {
        method: "GET",
        headers: headers
      });
      
      if (response.ok) {
        const anthropicResponse = await response.json();
        
        // 转换为OpenAI格式
        if (anthropicResponse && Array.isArray(anthropicResponse.models)) {
          return {
            object: "list",
            data: anthropicResponse.models.map(model => ({
              id: model.id || model.name,
              object: "model",
              created: Math.floor(new Date(model.created || Date.now()).getTime() / 1000),
              owned_by: "anthropic"
            }))
          };
        }
      }
    } catch (e) {
      console.error("Error fetching Anthropic models dynamically:", e);
    }
    
    // 如果API调用失败,使用静态列表
    return {
      object: "list",
      data: [
        {
          id: "claude-3-opus-20240229",
          object: "model",
          created: 1708992000, // 2024年2月时间戳
          owned_by: "anthropic"
        },
        {
          id: "claude-3-sonnet-20240229",
          object: "model",
          created: 1708992000,
          owned_by: "anthropic"
        },
        {
          id: "claude-3-haiku-20240307",
          object: "model",
          created: 1709769600, // 2024年3月时间戳
          owned_by: "anthropic"
        },
        {
          id: "claude-3.5-sonnet-20240620",
          object: "model",
          created: 1718928000, // 2024年6月近似时间戳
          owned_by: "anthropic"
        }
      ]
    };
  } catch (error) {
    console.error("Error creating Anthropic models list:", error);
    return { object: "list", data: [] };
  }
}

// 检查是否为模型列表请求
function isModelsRequest(path) {
  return path === '/v1/models' || path.startsWith('/v1/models?');
}

// 验证代理API密钥
function validateProxyApiKey(request, config) {
  // 如果没有设置代理API密钥,则不需要验证
  if (!config.proxyApiKey) {
    return true;
  }
  
  // 从请求头中获取API密钥
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  
  const apiKey = authHeader.substring(7).trim();
  
  // 检查API密钥是否匹配
  // 支持多个API密钥(逗号分隔)
  const validKeys = config.proxyApiKey.split(',').map(k => k.trim()).filter(Boolean);
  return validKeys.includes(apiKey);
}

// 提取上游API URL
function extractUpstreamUrl(request, config) {
  return request.headers.get("X-Upstream-URL") || config.defaultUpstreamUrl;
}

// 提取API密钥并进行负载均衡
function extractOutgoingApiKey(request, config) {
  // 首先尝试从自定义头部获取
  const customApiKey = request.headers.get("X-Outgoing-API-Key");
  if (customApiKey) return customApiKey;
  
  // 尝试从配置中获取并进行负载均衡
  if (config.defaultOutgoingApiKey) {
    const keys = config.defaultOutgoingApiKey.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 0) {
      // 简单的随机负载均衡
      return keys[Math.floor(Math.random() * keys.length)];
    }
  }
  
  // 最后尝试使用与请求相同的Authorization
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  
  return "";
}

// Gemini API密钥负载均衡
function getGeminiApiKey(request, config) {
  // 首先尝试自定义头部
  const customKey = request.headers.get("X-Gemini-API-Key");
  if (customKey) return customKey;
  
  // 进行负载均衡
  if (config.geminiApiKey) {
    const keys = config.geminiApiKey.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 0) {
      return keys[Math.floor(Math.random() * keys.length)];
    }
  }
  
  return "";
}

// Anthropic API密钥负载均衡
function getAnthropicApiKey(request, config) {
  // 首先尝试自定义头部
  const customKey = request.headers.get("X-Anthropic-API-Key");
  if (customKey) return customKey;
  
  // 进行负载均衡
  if (config.anthropicApiKey) {
    const keys = config.anthropicApiKey.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 0) {
      return keys[Math.floor(Math.random() * keys.length)];
    }
  }
  
  return "";
}

// 解析请求体和检查是否是流式请求
async function parseRequestBody(request) {
  let requestBody = {};
  let isStreamRequest = false;
  
  if (request.method === "POST") {
    try {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const clonedRequest = request.clone();
        requestBody = await clonedRequest.json();
        isStreamRequest = requestBody.stream === true;
      }
    } catch (e) {
      console.error("Error parsing request body:", e);
      throw new Error("Invalid JSON body");
    }
  }
  
  return { requestBody, isStreamRequest };
}

// 创建发送到OpenAI上游API的请求
function createUpstreamRequest(url, originalRequest, requestBody, apiKey) {
  const headers = new Headers(originalRequest.headers);
  
  // 设置API密钥
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  
  // 确保Content-Type正确设置
  if (originalRequest.method === "POST") {
    headers.set("Content-Type", "application/json");
  }
  
  // 移除自定义头部
  headers.delete("X-Upstream-URL");
  headers.delete("X-Outgoing-API-Key");
  headers.delete("X-Anthropic-API-Key");
  headers.delete("X-Gemini-API-Key");
  
  const requestInit = {
    method: originalRequest.method,
    headers: headers,
    redirect: "follow",
  };
  
  // 仅在POST请求时添加body
  if (originalRequest.method === "POST" && Object.keys(requestBody).length > 0) {
    requestInit.body = JSON.stringify(requestBody);
  }
  
  return new Request(url, requestInit);
}

// 创建Gemini API请求
async function createGeminiRequest(originalRequest, requestBody, config) {
  const apiKey = getGeminiApiKey(originalRequest, config);
  const geminiBody = convertToGeminiFormat(requestBody);
  const headers = new Headers();
  
  headers.set("Content-Type", "application/json");
  
  // 使用正确的端点URL格式和路径
  let modelName = geminiBody.model;
  if (!modelName.includes("/")) {
    modelName = `models/${modelName}`;  // 确保模型名称格式正确
  }
  
  // 确保使用正确的URL格式和API版本
  let geminiUrl = config.geminiUpstreamUrl;
  // 移除URL末尾的斜杠(如果有)
  if (geminiUrl.endsWith('/')) {
    geminiUrl = geminiUrl.slice(0, -1);
  }
  
  let url;
  if (requestBody.stream) {
    // 流式请求使用streamGenerateContent端点
    url = `${geminiUrl}/v1beta/${modelName}:streamGenerateContent?key=${apiKey}`;
    geminiBody.stream = true;
  } else {
    // 非流式请求使用generateContent端点
    url = `${geminiUrl}/v1beta/${modelName}:generateContent?key=${apiKey}`;
  }
  
  console.log(`Using Gemini URL: ${url}`); // 调试日志
  
  const requestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(geminiBody),
    redirect: "follow",
  };
  
  return new Request(url, requestInit);
}

// 创建Anthropic API请求
async function createAnthropicRequest(originalRequest, requestBody, config) {
  const apiKey = getAnthropicApiKey(originalRequest, config);
  const anthropicBody = convertToAnthropicFormat(requestBody);
  const headers = new Headers();
  
  headers.set("Content-Type", "application/json");
  headers.set("x-api-key", apiKey);
  headers.set("anthropic-version", "2023-06-01");
  
  let endpoint = "/v1/messages";
  if (requestBody.stream) {
    anthropicBody.stream = true;
  }
  
  const requestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(anthropicBody),
    redirect: "follow",
  };
  
  return new Request(`${config.anthropicUpstreamUrl}${endpoint}`, requestInit);
}

// OpenAI格式转换为Gemini格式
function convertToGeminiFormat(openAiBody) {
  // 简化Gemini请求体结构
  const geminiBody = {
    temperature: openAiBody.temperature !== undefined ? openAiBody.temperature : 0.7,
    topP: openAiBody.top_p !== undefined ? openAiBody.top_p : 0.95,
    topK: openAiBody.top_k !== undefined ? openAiBody.top_k : 40,
    maxOutputTokens: openAiBody.max_tokens !== undefined ? openAiBody.max_tokens : 2048,
    contents: []
  };
  
  // 处理模型名称映射
  const modelMap = {
    "gpt-3.5-turbo": "gemini-pro",
    "gpt-4": "gemini-1.5-pro",
    "gpt-4-turbo": "gemini-1.5-pro",
  };
  
  // 如果有提供的模型名称以gemini开头,直接使用它
  geminiBody.model = openAiBody.model && openAiBody.model.toString().startsWith("gemini") 
    ? openAiBody.model 
    : (modelMap[openAiBody.model] || "gemini-pro");
  
  // 处理系统消息
  let systemInstruction = "";
  
  // 转换消息格式
  if (openAiBody.messages && Array.isArray(openAiBody.messages)) {
    // 处理系统消息
    const systemMessages = openAiBody.messages.filter(msg => msg.role === "system");
    if (systemMessages.length > 0) {
      systemInstruction = systemMessages.map(msg => msg.content).join("\n");
    }
    
    // 处理用户和助手消息
    const nonSystemMessages = openAiBody.messages.filter(msg => msg.role !== "system");
    let currentMessages = [];
    
    for (let i = 0; i < nonSystemMessages.length; i++) {
      const msg = nonSystemMessages[i];
      
      if (msg.role === "user") {
        // 正确处理用户消息
        currentMessages.push({
          role: "user",
          parts: [{ text: msg.content }]
        });
      } else if (msg.role === "assistant") {
        // 正确处理助手消息
        currentMessages.push({
          role: "model",
          parts: [{ text: msg.content }]
        });
      }
    }
    
    // 将所有消息添加到contents数组
    geminiBody.contents = currentMessages;
  }
  
  // 如果有系统指令,添加到geminiBody
  if (systemInstruction) {
    geminiBody.systemInstruction = { text: systemInstruction };
  }
  
  return geminiBody;
}

// OpenAI格式转换为Anthropic格式
function convertToAnthropicFormat(openAiBody) {
  // 创建基本的Anthropic请求体
  const anthropicBody = {
    model: openAiBody.model && openAiBody.model.toString().startsWith("claude") 
      ? openAiBody.model 
      : "claude-3-opus-20240229", // 默认使用Claude 3
    max_tokens: openAiBody.max_tokens || 1024,
    temperature: openAiBody.temperature !== undefined ? openAiBody.temperature : 0.7,
    top_p: openAiBody.top_p !== undefined ? openAiBody.top_p : 0.95,
    stream: openAiBody.stream || false,
    messages: []
  };
  
  // 处理系统消息
  if (openAiBody.messages) {
    const systemMessages = openAiBody.messages.filter(msg => msg.role === "system");
    if (systemMessages.length > 0) {
      anthropicBody.system = systemMessages.map(msg => msg.content).join("\n");
    }
    
    // 处理用户和助手消息
    const nonSystemMessages = openAiBody.messages.filter(msg => msg.role !== "system");
    
    for (const msg of nonSystemMessages) {
      let role = msg.role;
      // Anthropic只支持用户和助手两种角色
      if (role !== "assistant" && role !== "user") {
        role = "user";
      }
      
      anthropicBody.messages.push({
        role: role,
        content: msg.content
      });
    }
  }
  
  return anthropicBody;
}

// 将非OpenAI响应转换为OpenAI格式
async function convertToOpenAIResponse(response, apiType, config) {
  // 如果不是成功的响应,直接返回
  if (!response.ok) {
    return addCorsHeaders(response);
  }
  
  // 克隆响应以获取内容
  const clonedResponse = response.clone();
  const contentType = response.headers.get("content-type") || "";
  
  // 如果不是JSON响应,直接返回
  if (!contentType.includes("application/json")) {
    return addCorsHeaders(response);
  }
  
  try {
    const responseData = await clonedResponse.json();
    let openAIFormatted;
    
    if (apiType === "gemini") {
      openAIFormatted = convertGeminiToOpenAIFormat(responseData);
    } else if (apiType === "anthropic") {
      openAIFormatted = convertAnthropicToOpenAIFormat(responseData);
    } else {
      return addCorsHeaders(response);
    }
    
    return new Response(JSON.stringify(openAIFormatted), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error(`Error converting ${apiType} response:`, error);
    return addCorsHeaders(response);
  }
}

// 将Gemini响应转换为OpenAI格式
function convertGeminiToOpenAIFormat(geminiResponse) {
  // 调试日志
  console.log("Gemini response:", JSON.stringify(geminiResponse).substring(0, 200) + "...");
  
  const openAIResponse = {
    id: `gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gemini", // 将在下面更新真实模型名称
    choices: [],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
  
  // 在Gemini响应中正确查找模型名称和使用统计
  if (geminiResponse.modelId) {
    openAIResponse.model = geminiResponse.modelId;
  } else if (geminiResponse.candidates && geminiResponse.candidates[0] && geminiResponse.candidates[0].modelId) {
    openAIResponse.model = geminiResponse.candidates[0].modelId;
  }
  
  // 正确查找和处理使用统计
  if (geminiResponse.usageMetadata) {
    openAIResponse.usage.prompt_tokens = geminiResponse.usageMetadata.promptTokenCount || 0;
    openAIResponse.usage.completion_tokens = geminiResponse.usageMetadata.candidatesTokenCount || 0;
    openAIResponse.usage.total_tokens = openAIResponse.usage.prompt_tokens + openAIResponse.usage.completion_tokens;
  }
  
  // 处理不同格式的Gemini响应
  let content = "";
  
  // 从candidates数组中提取文本内容
  if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
    const candidate = geminiResponse.candidates[0];
    
    // 处理Gemini API 不同可能的响应结构
    if (candidate.content && candidate.content.parts) {
      content = candidate.content.parts.map(part => part.text || "").join("");
    } else if (candidate.text) {
      content = candidate.text;
    } else if (candidate.content) {
      // 直接尝试从content中获取文本
      content = typeof candidate.content === 'string' ? candidate.content : JSON.stringify(candidate.content);
    }
    
    // 设置完成原因
    const finishReason = candidate.finishReason || "stop";
    
    // 将处理后的内容添加到OpenAI响应中
    openAIResponse.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: content
      },
      finish_reason: finishReason
    });
  } else if (geminiResponse.text) {
    // 处理可能的简单文本响应
    openAIResponse.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: geminiResponse.text
      },
      finish_reason: "stop"
    });
  } else if (geminiResponse.content) {
    // 处理直接的content对象
    let contentText = "";
    
    if (typeof geminiResponse.content === 'string') {
      contentText = geminiResponse.content;
    } else if (geminiResponse.content.parts) {
      contentText = geminiResponse.content.parts.map(part => part.text || "").join("");
    } else {
      contentText = JSON.stringify(geminiResponse.content);
    }
    
    openAIResponse.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: contentText
      },
      finish_reason: "stop"
    });
  }
  
  return openAIResponse;
}

// 将Anthropic响应转换为OpenAI格式
function convertAnthropicToOpenAIFormat(anthropicResponse) {
  const openAIResponse = {
    id: `anthropic-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicResponse.model || "claude-3",
    choices: [],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens: (anthropicResponse.usage?.input_tokens || 0) + 
                    (anthropicResponse.usage?.output_tokens || 0)
    }
  };
  
  // 处理Anthropic响应内容
  if (anthropicResponse.content && anthropicResponse.content.length > 0) {
    let content = "";
    
    // 合并所有内容块
    for (const block of anthropicResponse.content) {
      if (block.type === "text") {
        content += block.text || "";
      }
    }
    
    openAIResponse.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: content
      },
      finish_reason: anthropicResponse.stop_reason || "stop"
    });
  }
  
  return openAIResponse;
}

// 创建错误响应
function createErrorResponse(error) {
  const status = error.message === "Invalid JSON body" ? 400 : 500;
  const body = JSON.stringify({
    error: {
      message: error.message || (status === 400 ? "Bad Request" : "Internal Server Error"),
      type: status === 400 ? "invalid_request_error" : "server_error",
      code: status
    }
  });
  
  return new Response(body, {
    status: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// 处理流式响应
async function handleStreamingResponse(response, apiType, config) {
  const { readable, writable } = new TransformStream();
  
  processStreamedResponse(response.body, writable, apiType, config).catch(err => {
    console.error("Error processing stream:", err);
    writable.abort(err);
  });
  
  return addCorsHeaders(new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  }));
}

// 处理流式响应数据
async function processStreamedResponse(inputStream, outputWriter, apiType, config) {
  const reader = inputStream.getReader();
  const writer = outputWriter.getWriter();
  
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  
  let buffer = "";
  let lastChunkTime = Date.now();
  let recentChunkSizes = [];
  let currentDelay = config.minDelay;
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        if (buffer.length > 0) {
          // 处理缓冲区剩余内容
          if (apiType === "openai") {
            await processSSELine(buffer, writer, encoder, currentDelay, config);
          } else if (apiType === "gemini") {
            await processGeminiSSELine(buffer, writer, encoder, currentDelay, config);
          } else if (apiType === "anthropic") {
            await processAnthropicSSELine(buffer, writer, encoder, currentDelay, config);
          }
        }
        break;
      }
      
      // 更新时间跟踪和延迟计算
      const currentTime = Date.now();
      const timeSinceLastChunk = currentTime - lastChunkTime;
      lastChunkTime = currentTime;
      
      if (value && value.length) {
        // 更新最近块大小列表
        recentChunkSizes.push(value.length);
        if (recentChunkSizes.length > config.chunkBufferSize) {
          recentChunkSizes.shift();
        }
        
        // 计算新的延迟
        const avgChunkSize = recentChunkSizes.reduce((a, b) => a + b, 0) / recentChunkSizes.length;
        currentDelay = adaptDelay(avgChunkSize, timeSinceLastChunk, config);
      }
      
      // 处理接收到的数据
      buffer += decoder.decode(value, { stream: true });
      
      // 按行处理SSE消息
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (apiType === "openai") {
          await processSSELine(line, writer, encoder, currentDelay, config);
        } else if (apiType === "gemini") {
          await processGeminiSSELine(line, writer, encoder, currentDelay, config);
        } else if (apiType === "anthropic") {
          await processAnthropicSSELine(line, writer, encoder, currentDelay, config);
        }
      }
    }
  } catch (e) {
    console.error("Stream processing error:", e);
  } finally {
    try {
      await writer.close();
    } catch (e) {
      console.error("Error closing writer:", e);
    }
    reader.releaseLock();
  }
}

// 处理OpenAI格式的SSE行
async function processSSELine(line, writer, encoder, delay, config) {
  if (!line.trim()) {
    // 保留空行的换行符
    await writer.write(encoder.encode("\n"));
    return;
  }
  
  if (line.startsWith("data: ")) {
    const data = line.slice(6);
    
    if (data === "[DONE]") {
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    
    try {
      const jsonData = JSON.parse(data);
      
      // 处理OpenAI兼容格式的响应
      if (jsonData.choices && jsonData.choices.length > 0) {
        const choice = jsonData.choices[0];
        
        // 确定API类型和内容
        let content = "";
        let isCompletionAPI = false;
        
        if (choice.delta && choice.delta.content !== undefined) {
          // ChatGPT格式
          content = choice.delta.content;
        } else if (choice.text !== undefined) {
          // Completions格式
          content = choice.text;
          isCompletionAPI = true;
        }
        
        if (content) {
          // 逐字符发送内容
          await sendContentCharByChar(content, jsonData, writer, encoder, delay, isCompletionAPI);
        } else {
          // 对于没有文本内容的消息,原样发送
          await writer.write(encoder.encode(`data: ${data}\n\n`));
        }
      } else {
        // 对于不含choices的消息,原样发送
        await writer.write(encoder.encode(`data: ${data}\n\n`));
      }
    } catch (e) {
      console.error("Error parsing JSON data:", e);
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    }
  } else {
    // 对于非data行,原样发送
    await writer.write(encoder.encode(`${line}\n`));
  }
}

// 处理Gemini格式的SSE行并转换为OpenAI格式
async function processGeminiSSELine(line, writer, encoder, delay, config) {
  if (!line.trim()) {
    await writer.write(encoder.encode("\n"));
    return;
  }
  
  // 调试日志
  if (line.startsWith("data: ")) {
    console.log(`Processing Gemini SSE line: ${line.substring(0, 50)}...`);
  }
  
  // Gemini SSE格式处理
  if (line.startsWith("data: ")) {
    const data = line.slice(6);
    
    if (data === "[DONE]") {
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    
    try {
      const geminiData = JSON.parse(data);
      
      // 处理Gemini流式响应中可能的不同结构
      let textContent = "";
      
      // 获取文本内容 - 处理多种可能的结构
      if (geminiData.candidates && geminiData.candidates.length > 0) {
        const candidate = geminiData.candidates[0];
        
        if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
          textContent = candidate.content.parts[0].text || "";
        } else if (candidate.text) {
          textContent = candidate.text;
        } else if (candidate.delta && candidate.delta.text) {
          textContent = candidate.delta.text;
        }
      } else if (geminiData.text) {
        textContent = geminiData.text;
      } else if (geminiData.delta && geminiData.delta.text) {
        textContent = geminiData.delta.text;
      }
      
      if (textContent) {
        // 转换为OpenAI格式
        const openAIFormat = {
          id: `gemini-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gemini",
          choices: [{
            index: 0,
            delta: {
              content: textContent
            },
            finish_reason: null
          }]
        };
        
        // 逐字符发送
        await sendContentCharByChar(textContent, openAIFormat, writer, encoder, delay, false);
      } else if (geminiData.promptFeedback || geminiData.usageMetadata) {
        // 处理Gemini的结束消息
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } else {
        // 其他情况,发送空delta表示结束
        const openAIFormat = {
          id: `gemini-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gemini",
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        };
        
        await writer.write(encoder.encode(`data: ${JSON.stringify(openAIFormat)}\n\n`));
      }
    } catch (e) {
      console.error("Error parsing Gemini SSE:", e);
      // 发送原始数据
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    }
  } else {
    // 非data行
    await writer.write(encoder.encode(`${line}\n`));
  }
}

// 处理Anthropic格式的SSE行并转换为OpenAI格式
async function processAnthropicSSELine(line, writer, encoder, delay, config) {
  if (!line.trim()) {
    await writer.write(encoder.encode("\n"));
    return;
  }
  
  // Anthropic SSE格式: "data: {"type":"content_block_delta","delta":{"text":"..."}}"
  if (line.startsWith("data: ")) {
    const data = line.slice(6);
    
    if (data === "[DONE]") {
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    
    try {
      const anthropicData = JSON.parse(data);
      
      // 处理内容块增量
      if (anthropicData.type === "content_block_delta" && 
          anthropicData.delta && anthropicData.delta.text) {
        
        const textContent = anthropicData.delta.text;
        
        if (textContent) {
          // 转换为OpenAI格式
          const openAIFormat = {
            id: `anthropic-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "claude-3",
            choices: [{
              index: 0,
              delta: {
                content: textContent
              },
              finish_reason: null
            }]
          };
          
          // 逐字符发送
          await sendContentCharByChar(textContent, openAIFormat, writer, encoder, delay, false);
        }
      } else if (anthropicData.type === "message_stop") {
        // 结束消息
        const openAIFormat = {
          id: `anthropic-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "claude-3",
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        };
        
        await writer.write(encoder.encode(`data: ${JSON.stringify(openAIFormat)}\n\n`));
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } else {
        // 其他消息类型,直接发送原始数据
        await writer.write(encoder.encode(`data: ${data}\n\n`));
      }
    } catch (e) {
      console.error("Error parsing Anthropic SSE:", e);
      // 发送原始数据
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    }
  } else {
    // 非data行
    await writer.write(encoder.encode(`${line}\n`));
  }
}

// 自适应调整延迟
function adaptDelay(chunkSize, timeSinceLastChunk, config) {
  if (chunkSize <= 0) return config.minDelay;
  
  // 块大小反比因子:块越大,字符间延迟越小
  const sizeInverseFactor = Math.max(0.2, Math.min(2.0, 50 / chunkSize));
  
  // 时间因子:接收间隔越长,延迟越大
  const timeFactor = Math.max(0.5, Math.min(1.5, timeSinceLastChunk / 300));
  
  // 组合因子计算最终延迟
  const adaptiveDelay = config.minDelay + 
    (config.maxDelay - config.minDelay) * 
    sizeInverseFactor * timeFactor * config.adaptiveDelayFactor;
  
  // 确保延迟在允许范围内
  return Math.min(config.maxDelay, Math.max(config.minDelay, adaptiveDelay));
}

// 逐字符发送内容
async function sendContentCharByChar(content, originalJson, writer, encoder, delay, isCompletionAPI) {
  if (!content) return;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    let charResponse;
    
    // 根据API类型创建单字符响应
    if (isCompletionAPI) {
      // Completions API格式
      charResponse = {
        ...originalJson,
        choices: [{
          ...originalJson.choices[0],
          text: char
        }]
      };
    } else {
      // ChatGPT格式
      charResponse = {
        ...originalJson,
        choices: [{
          ...originalJson.choices[0],
          delta: { content: char }
        }]
      };
    }
    
    // 发送单字符的JSON
    await writer.write(encoder.encode(`}\n\n`));
    
    // 添加延迟,除了最后一个字符
    if (i < content.length - 1 && delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// 处理CORS预检请求
function handleCORS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Upstream-URL, X-Outgoing-API-Key, X-Anthropic-API-Key, X-Gemini-API-Key",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// 添加CORS头
function addCorsHeaders(response) {
  const corsHeaders = new Headers(response.headers);
  corsHeaders.set("Access-Control-Allow-Origin", "*");
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: corsHeaders,
  });
}
