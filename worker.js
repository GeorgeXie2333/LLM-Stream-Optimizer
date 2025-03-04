/**
 * 多提供商AI API兼容代理
 * 支持OpenAI、Anthropic、Gemini API
 * 自动检测模型类型路由到相应API
 * 实现多API密钥负载均衡
 * 智能字符流式输出优化
 * 支持Web管理界面
 */

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

// 导入Cloudflare Sockets API
import { connect } from "cloudflare:sockets";

// 文本编码器和解码器
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 处理HTTP请求头过滤
const HEADER_FILTER_RE = /^(host|accept-encoding|cf-)/i;

// 连接多个Uint8Array
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

// 解析HTTP响应头
function parseHttpHeaders(buff) {
  const text = decoder.decode(buff);
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerSection = text.slice(0, headerEnd).split("\r\n");
  const statusLine = headerSection[0];
  const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
  if (!statusMatch) throw new Error(`状态行无效: ${statusLine}`);
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

// 读取直到遇到双CRLF (HTTP头结束)
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

// 读取分块编码数据
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
    if (!size) break;
    buff = buff.slice(pos + 2);
    while (buff.length < size + 2) {
      const { value, done } = await reader.read();
      if (done) throw new Error("分块编码中意外的EOF");
      buff = concatUint8Arrays(buff, value);
    }
    yield buff.slice(0, size);
    buff = buff.slice(size + 2);
  }
}

// 解析完整HTTP响应
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
                  for await (const chunk of readChunks(reader, data)) {
                    ctrl.enqueue(chunk);
                  }
                } else {
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
                console.error("解析响应时出错", err);
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
  throw new Error("无法解析响应头");
}

// 生成WebSocket密钥
function generateWebSocketKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

// 打包文本WebSocket帧
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
    throw new Error("载荷太大");
  }
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  const maskedPayload = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payload[i] ^ mask[i % 4];
  }
  return concatUint8Arrays(header, mask, maskedPayload);
}

// WebSocket帧解析器
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
        throw new Error("不支持127长度模式");
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
          throw new Error("收到没有初始化的延续帧");
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

// 中继WebSocket帧
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
      console.error("远程写入错误", e);
    }
  });
  
  (async function relayFrames() {
    const frameReader = new SocketFramesReader(reader);
    try {
      while (true) {
        const frame = await frameReader.nextFrame();
        if (!frame) break;
        switch (frame.opcode) {
          case 1: // 文本帧
          case 2: // 二进制帧
            ws.send(frame.payload);
            break;
          case 8: // 关闭帧
            ws.close(1000);
            return;
          default:
            console.log(`收到未知帧类型, 操作码: ${frame.opcode}`);
        }
      }
    } catch (e) {
      console.error("读取远程帧时出错", e);
    } finally {
      ws.close();
      writer.releaseLock();
      socket.close();
    }
  })();
  
  ws.addEventListener("close", () => socket.close());
}

// 原生fetch实现
async function nativeFetch(req, dstUrl) {
  // 确定实际URL
  const targetUrl = new URL(dstUrl);
  
  // 检查是否为Request对象还是已经构造好的RequestInit对象
  if (req instanceof Request) {
    // 清理请求头
    const cleanedHeaders = new Headers();
    for (const [k, v] of req.headers) {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    }
    
    // 检查是否为WebSocket请求
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      // WebSocket处理逻辑保持不变
      if (!/^wss?:\/\//i.test(dstUrl)) {
        return new Response("目标不支持WebSocket", { status: 400 });
      }
      const isSecure = targetUrl.protocol === "wss:";
      const port = targetUrl.port || (isSecure ? 443 : 80);
      // 建立原生socket连接
      const socket = await connect(
        { hostname: targetUrl.hostname, port: Number(port) },
        { secureTransport: isSecure ? "on" : "off" }
      );
    
      // 生成WebSocket握手密钥
      const key = generateWebSocketKey();

      // 构建握手请求头
      cleanedHeaders.set('Host', targetUrl.hostname);
      cleanedHeaders.set('Connection', 'Upgrade');
      cleanedHeaders.set('Upgrade', 'websocket');
      cleanedHeaders.set('Sec-WebSocket-Version', '13');
      cleanedHeaders.set('Sec-WebSocket-Key', key);
    
      // 组装握手请求数据
      const handshakeReq =
        `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n';

      console.log("发送WebSocket握手请求", handshakeReq);
      const writer = socket.writable.getWriter();
      await writer.write(encoder.encode(handshakeReq));
    
      const reader = socket.readable.getReader();
      const handshakeResp = await readUntilDoubleCRLF(reader);
      console.log("收到握手响应", handshakeResp);
      
      if (
        !handshakeResp.includes("101") ||
        !handshakeResp.includes("Switching Protocols")
      ) {
        throw new Error("WebSocket握手失败: " + handshakeResp);
      }
    
      // 创建WebSocketPair
      const [client, server] = new WebSocketPair();
      client.accept();
      // 建立双向帧中继
      relayWebSocketFrames(client, socket, writer, reader);
      
      return new Response(null, { status: 101, webSocket: server });
    } else {
      // 标准HTTP请求处理
      cleanedHeaders.set("Host", targetUrl.hostname);
      cleanedHeaders.set("accept-encoding", "identity");
      
      // 先处理请求体，这样我们可以设置正确的Content-Length
      let bodyBuffer = null;
      
      if (req.body) {
        try {
          // 尝试复制并获取请求体用于计算长度
          const clonedReq = req.clone();
          const bodyChunks = [];
          for await (const chunk of clonedReq.body) {
            bodyChunks.push(chunk);
          }
          // 合并所有的块
          bodyBuffer = concatUint8Arrays(...bodyChunks);
          
          // 设置Content-Length头
          cleanedHeaders.set("Content-Length", bodyBuffer.length.toString());
          console.log(`设置Content-Length: ${bodyBuffer.length}`);
        } catch (error) {
          console.error("处理请求体时出错:", error);
          throw error;
        }
      } else {
        // 如果没有请求体，将Content-Length设置为0
        cleanedHeaders.set("Content-Length", "0");
      }
    
      const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
      const socket = await connect(
        { hostname: targetUrl.hostname, port: Number(port) },
        { secureTransport: targetUrl.protocol === "https:" ? "on" : "off" }
      );
      const writer = socket.writable.getWriter();
      
      // 构建请求行和头部
      const requestLine =
        `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
        
      console.log("发送请求", requestLine);
      await writer.write(encoder.encode(requestLine));
    
      // 如果有请求体,发送已缓存的数据
      if (bodyBuffer) {
        console.log("发送请求体", bodyBuffer.length);
        await writer.write(bodyBuffer);
      }
      
      // 解析并返回目标服务器的响应
      return await parseResponse(socket.readable.getReader());
    }
  } else {
    // 如果是直接传递的RequestInit对象（比如createUpstreamRequest的返回值）
    // 直接提取需要的数据并发送
    const method = req.method || "GET";
    const headers = req.headers || new Headers();
    const body = req.body;
    
    // 清理请求头
    const cleanedHeaders = new Headers();
    for (const [k, v] of headers.entries()) {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    }
    
    // 标准HTTP请求处理
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
    
    // 处理请求体
    let bodyBuffer = null;
    
    if (body && typeof body === 'string') {
      // 如果请求体是字符串，直接编码
      bodyBuffer = encoder.encode(body);
      cleanedHeaders.set("Content-Length", bodyBuffer.length.toString());
    } else if (body) {
      console.error("不支持的请求体类型", typeof body);
      throw new Error("不支持的请求体类型");
    } else {
      // 如果没有请求体，将Content-Length设置为0
      cleanedHeaders.set("Content-Length", "0");
    }
    
    const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
    const socket = await connect(
      { hostname: targetUrl.hostname, port: Number(port) },
      { secureTransport: targetUrl.protocol === "https:" ? "on" : "off" }
    );
    const writer = socket.writable.getWriter();
    
    // 构建请求行和头部
    const requestLine =
      `${method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(cleanedHeaders.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n";
      
    console.log("发送请求", requestLine);
    await writer.write(encoder.encode(requestLine));
    
    // 如果有请求体,发送数据
    if (bodyBuffer) {
      console.log("发送请求体", bodyBuffer.length);
      await writer.write(bodyBuffer);
    }
    
    // 解析并返回目标服务器的响应
    return await parseResponse(socket.readable.getReader());
  }
}

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
    
    // 处理API请求
    return await handleRequest(request, config);
  }
};

// 从KV存储加载配置
async function loadConfigFromKV(env) {
  // 检查是否有KV绑定
  if (!env.CONFIG_KV) {
    console.log("未检测到KV绑定，使用环境变量作为配置");
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
    
    // 如果KV中没有某些配置，则使用环境变量作为后备
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
    return { success: false, message: "未检测到KV绑定，无法保存配置" };
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
    // 如果已登录，提供仪表盘
    if (isLoggedIn) {
      return serveDashboardPage();
    } else {
      // 未登录，重定向到登录页面
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
    
    // 生成会话令牌（使用密码的哈希作为会话令牌）
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
      
      // 仅更新非空API密钥（防止覆盖现有密钥）
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
      <title>Better Stream Optimizer - 管理登录</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --primary-color: #4361ee;
          --primary-hover: #3a56d4;
          --secondary-color: #7209b7;
          --accent-color: #4cc9f0;
          --light-bg: #f8f9fa;
          --dark-text: #2b2d42;
          --light-text: #8d99ae;
          --card-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
          --transition: all 0.3s ease;
        }
        
        body {
          background: linear-gradient(135deg, #f5f7fa 0%, #e5e9f2 100%);
          font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--dark-text);
          margin: 0;
          padding: 20px;
        }
        
        .login-container {
          width: 90%;
          max-width: 450px;
          padding: 2.5rem;
          background-color: #fff;
          border-radius: 12px;
          box-shadow: var(--card-shadow);
          transform: translateY(0);
          transition: var(--transition);
          position: relative;
          overflow: hidden;
          margin: 0 auto;
        }
        
        .login-container:hover {
          transform: translateY(-5px);
          box-shadow: 0 15px 35px rgba(0, 0, 0, 0.12);
        }
        
        .login-container::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 6px;
          background: linear-gradient(90deg, var(--primary-color), var(--secondary-color));
        }
        
        .login-title {
          text-align: center;
          margin-bottom: 2rem;
          color: var(--dark-text);
          font-weight: 700;
          position: relative;
        }
        
        .login-title::after {
          content: "";
          display: block;
          width: 60px;
          height: 3px;
          background: linear-gradient(90deg, var(--primary-color), var(--secondary-color));
          margin: 0.8rem auto 0;
          border-radius: 3px;
        }
        
        .form-control {
          border: 2px solid #e9ecef;
          padding: 0.8rem 1rem;
          border-radius: 8px;
          transition: var(--transition);
        }
        
        .form-control:focus {
          border-color: var(--primary-color);
          box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.15);
        }
        
        .form-label {
          font-weight: 500;
          color: var(--dark-text);
        }
        
        .form-text {
          color: var(--light-text);
          font-size: 0.85rem;
        }
        
        .login-btn {
          width: 100%;
          padding: 0.8rem;
          border-radius: 8px;
          background-color: var(--primary-color);
          border: none;
          font-weight: 500;
          letter-spacing: 0.5px;
          transition: var(--transition);
          position: relative;
          overflow: hidden;
        }
        
        .login-btn:hover {
          background-color: var(--primary-hover);
          transform: translateY(-2px);
        }
        
        .login-btn:active {
          transform: translateY(0);
        }
        
        .alert {
          border-radius: 8px;
          padding: 1rem;
          border: none;
          display: none;
          animation: fadeIn 0.3s ease;
        }
        
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        .password-wrapper {
          position: relative;
        }
        
        .password-toggle {
          position: absolute;
          right: 15px;
          top: 50%;
          transform: translateY(-50%);
          border: none;
          background: transparent;
          color: var(--light-text);
          cursor: pointer;
        }
        
        .brand-icon {
          text-align: center;
          margin-bottom: 1.5rem;
          font-size: 3rem;
          color: var(--primary-color);
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <div class="brand-icon">
          <i class="bi bi-hdd-network"></i>
        </div>
        <h2 class="login-title">Better Stream Optimizer管理</h2>
        <div id="loginAlert" class="alert alert-danger mb-3" role="alert"></div>
        <form id="loginForm">
          <div class="mb-4">
            <label for="password" class="form-label">管理员密码</label>
            <div class="password-wrapper">
              <input type="password" class="form-control" id="password" required>
              <button type="button" class="password-toggle" aria-label="显示/隐藏密码">
                <i class="bi bi-eye"></i>
              </button>
            </div>
            <div class="form-text mt-2">请输入代理API密钥作为管理员密码</div>
          </div>
          <button type="submit" class="btn btn-primary login-btn">
            <i class="bi bi-unlock me-2"></i>登录
          </button>
        </form>
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
              // 登录成功，跳转到仪表盘
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
        
        // 密码显示切换
        document.querySelector('.password-toggle').addEventListener('click', function() {
          const passwordInput = document.getElementById('password');
          const icon = this.querySelector('i');
          
          if (passwordInput.type === 'password') {
            passwordInput.type = 'text';
            icon.classList.remove('bi-eye');
            icon.classList.add('bi-eye-slash');
          } else {
            passwordInput.type = 'password';
            icon.classList.remove('bi-eye-slash');
            icon.classList.add('bi-eye');
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
      <title>Better Stream Optimizer - 管理仪表盘</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --primary-color: #4361ee;
          --primary-hover: #3a56d4;
          --secondary-color: #7209b7;
          --accent-color: #4cc9f0;
          --success-color: #06d6a0;
          --warning-color: #ffd166;
          --danger-color: #ef476f;
          --light-bg: #f8f9fa;
          --dark-bg: #2b2d42;
          --card-bg: #ffffff;
          --dark-text: #2b2d42;
          --light-text: #8d99ae;
          --card-shadow: 0 8px 20px rgba(0, 0, 0, 0.06);
          --transition: all 0.3s ease;
        }
        
        body {
          background-color: #f5f7fa;
          font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
          color: var(--dark-text);
          padding-bottom: 3rem;
          min-height: 100vh;
        }
        
        .dashboard-header {
          background-color: var(--card-bg);
          box-shadow: 0 3px 15px rgba(0, 0, 0, 0.05);
          padding: 1.25rem 0;
          margin-bottom: 2rem;
          position: sticky;
          top: 0;
          z-index: 100;
        }
        
        .header-container {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .dashboard-brand {
          display: flex;
          align-items: center;
          color: var(--dark-text);
          text-decoration: none;
        }
        
        .brand-icon {
          font-size: 1.75rem;
          color: var(--primary-color);
          margin-right: 0.75rem;
        }
        
        .nav-tabs {
          margin-bottom: 1.5rem;
          border-bottom: 2px solid #e9ecef;
          padding-bottom: 0;
        }
        
        .nav-tabs .nav-link {
          border: none;
          font-weight: 500;
          color: var(--light-text);
          padding: 0.75rem 1.25rem;
          border-radius: 8px 8px 0 0;
          transition: var(--transition);
          position: relative;
        }
        
        .nav-tabs .nav-link:hover {
          color: var(--primary-color);
          background-color: rgba(67, 97, 238, 0.05);
        }
        
        .nav-tabs .nav-link.active {
          color: var(--primary-color);
          background-color: transparent;
          font-weight: 600;
        }
        
        .nav-tabs .nav-link.active::after {
          content: "";
          position: absolute;
          bottom: -2px;
          left: 0;
          width: 100%;
          height: 3px;
          background-color: var(--primary-color);
          border-radius: 3px 3px 0 0;
        }
        
        .nav-tabs .nav-link i {
          margin-right: 0.5rem;
        }
        
        .config-card {
          background-color: var(--card-bg);
          border-radius: 12px;
          box-shadow: var(--card-shadow);
          padding: 1.75rem;
          margin-bottom: 1.5rem;
          transition: var(--transition);
          border: none;
        }
        
        .config-card:hover {
          box-shadow: 0 12px 25px rgba(0, 0, 0, 0.08);
          transform: translateY(-3px);
        }
        
        .card-title {
          margin-bottom: 1.5rem;
          color: var(--dark-text);
          font-weight: 600;
          display: flex;
          align-items: center;
        }
        
        .card-title i {
          margin-right: 0.75rem;
          color: var(--primary-color);
          font-size: 1.25rem;
        }
        
        .btn-save {
          min-width: 120px;
          padding: 0.7rem 1.5rem;
          font-weight: 500;
          letter-spacing: 0.5px;
          border-radius: 8px;
          background-color: var(--primary-color);
          border: none;
          transition: var(--transition);
        }
        
        .btn-save:hover {
          background-color: var(--primary-hover);
          transform: translateY(-2px);
          box-shadow: 0 5px 15px rgba(67, 97, 238, 0.2);
        }
        
        .btn-save:active {
          transform: translateY(0);
        }
        
        .btn-save i {
          margin-right: 0.5rem;
        }
        
        .status-badge {
          font-size: 0.75rem;
          font-weight: 500;
          padding: 0.35rem 0.75rem;
          border-radius: 20px;
        }
        
        .bg-success {
          background-color: var(--success-color) !important;
        }
        
        .bg-secondary {
          background-color: var(--light-text) !important;
        }
        
        .form-control {
          border: 2px solid #e9ecef;
          padding: 0.8rem 1rem;
          border-radius: 8px;
          transition: var(--transition);
        }
        
        .form-control:focus {
          border-color: var(--primary-color);
          box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.15);
        }
        
        .form-label {
          font-weight: 500;
          color: var(--dark-text);
          margin-bottom: 0.5rem;
        }
        
        .form-text {
          color: var(--light-text);
          font-size: 0.85rem;
          margin-top: 0.5rem;
        }
        
        .alert {
          border-radius: 10px;
          padding: 1rem 1.25rem;
          border: none;
          display: none;
          animation: slideDown 0.4s ease;
        }
        
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        #logoutBtn {
          padding: 0.5rem 1rem;
          border-radius: 8px;
          border: 2px solid #e9ecef;
          background: transparent;
          color: var(--dark-text);
          font-weight: 500;
          transition: var(--transition);
        }
        
        #logoutBtn:hover {
          background-color: #f8f9fa;
          border-color: #d1d5db;
        }
        
        #logoutBtn i {
          margin-right: 0.5rem;
        }
        
        .api-key-wrapper {
          position: relative;
        }
        
        .api-key-toggle {
          position: absolute;
          right: 15px;
          top: 50%;
          transform: translateY(-50%);
          border: none;
          background: transparent;
          color: var(--light-text);
          cursor: pointer;
        }
        
        .url-icon {
          position: absolute;
          left: 15px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--light-text);
        }
        
        .has-url-icon {
          padding-left: 2.8rem;
        }
        
        .tab-icon {
          margin-right: 0.5rem;
        }
        
        .section-divider {
          height: 1px;
          background: linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(233,236,239,1) 50%, rgba(0,0,0,0) 100%);
          margin: 2rem 0;
        }
        
        .form-footer {
          display: flex;
          justify-content: flex-end;
          margin-top: 1.5rem;
        }
      </style>
    </head>
    <body>
      <header class="dashboard-header">
        <div class="container">
          <div class="header-container">
            <a href="/admin/dashboard" class="dashboard-brand">
              <div class="brand-icon"><i class="bi bi-hdd-network"></i></div>
              <h1 class="h3 mb-0">Better Stream Optimizer管理</h1>
            </a>
            <button id="logoutBtn" class="btn">
              <i class="bi bi-box-arrow-right"></i>退出登录
            </button>
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
            <button class="nav-link active" id="openai-tab" data-bs-toggle="tab" data-bs-target="#openai" type="button" role="tab" aria-controls="openai" aria-selected="true">
              <i class="bi bi-chat-square-text tab-icon"></i>OpenAI配置
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="anthropic-tab" data-bs-toggle="tab" data-bs-target="#anthropic" type="button" role="tab" aria-controls="anthropic" aria-selected="false">
              <i class="bi bi-stars tab-icon"></i>Anthropic配置
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="gemini-tab" data-bs-toggle="tab" data-bs-target="#gemini" type="button" role="tab" aria-controls="gemini" aria-selected="false">
              <i class="bi bi-gem tab-icon"></i>Gemini配置
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="general-tab" data-bs-toggle="tab" data-bs-target="#general" type="button" role="tab" aria-controls="general" aria-selected="false">
              <i class="bi bi-gear tab-icon"></i>通用设置
            </button>
          </li>
        </ul>
        
        <div class="tab-content" id="configTabsContent">
          <!-- OpenAI配置 -->
          <div class="tab-pane fade show active" id="openai" role="tabpanel" aria-labelledby="openai-tab">
            <div class="config-card">
              <h5 class="card-title"><i class="bi bi-chat-square-text"></i>OpenAI格式 API配置</h5>
              <form id="openaiForm">
                <div class="mb-4">
                  <label for="defaultUpstreamUrl" class="form-label">API端点URL</label>
                  <div class="position-relative">
                    <i class="bi bi-link-45deg url-icon"></i>
                    <input type="url" class="form-control has-url-icon" id="defaultUpstreamUrl" placeholder="https://api.openai.com">
                  </div>
                  <div class="form-text">OpenAI格式 API端点URL，默认为官方API</div>
                </div>
                <div class="mb-4">
                  <label for="defaultOutgoingApiKey" class="form-label">API密钥</label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control" id="defaultOutgoingApiKey" placeholder="sk-...">
                    <button type="button" class="api-key-toggle" data-target="defaultOutgoingApiKey">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">可以设置多个API密钥，使用逗号分隔，系统会自动负载均衡</div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存配置
                  </button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Anthropic配置 -->
          <div class="tab-pane fade" id="anthropic" role="tabpanel" aria-labelledby="anthropic-tab">
            <div class="config-card">
              <h5 class="card-title">
                <i class="bi bi-stars"></i>
                Anthropic格式 API配置
                <span id="anthropicStatus" class="badge rounded-pill ms-2 status-badge bg-secondary">未启用</span>
              </h5>
              <form id="anthropicForm">
                <div class="mb-4">
                  <label for="anthropicUpstreamUrl" class="form-label">API端点URL</label>
                  <div class="position-relative">
                    <i class="bi bi-link-45deg url-icon"></i>
                    <input type="url" class="form-control has-url-icon" id="anthropicUpstreamUrl" placeholder="https://api.anthropic.com">
                  </div>
                  <div class="form-text">Anthropic格式 API端点URL</div>
                </div>
                <div class="mb-4">
                  <label for="anthropicApiKey" class="form-label">API密钥</label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control" id="anthropicApiKey" placeholder="sk-ant-...">
                    <button type="button" class="api-key-toggle" data-target="anthropicApiKey">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">可以设置多个API密钥，使用逗号分隔，系统会自动负载均衡</div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存配置
                  </button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- Gemini配置 -->
          <div class="tab-pane fade" id="gemini" role="tabpanel" aria-labelledby="gemini-tab">
            <div class="config-card">
              <h5 class="card-title">
                <i class="bi bi-gem"></i>
                Gemini格式 API配置
                <span id="geminiStatus" class="badge rounded-pill ms-2 status-badge bg-secondary">未启用</span>
              </h5>
              <form id="geminiForm">
                <div class="mb-4">
                  <label for="geminiUpstreamUrl" class="form-label">API端点URL</label>
                  <div class="position-relative">
                    <i class="bi bi-link-45deg url-icon"></i>
                    <input type="url" class="form-control has-url-icon" id="geminiUpstreamUrl" placeholder="https://generativelanguage.googleapis.com">
                  </div>
                  <div class="form-text">Gemini API端点URL</div>
                </div>
                <div class="mb-4">
                  <label for="geminiApiKey" class="form-label">API密钥</label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control" id="geminiApiKey" placeholder="AIzaSy...">
                    <button type="button" class="api-key-toggle" data-target="geminiApiKey">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">可以设置多个API密钥，使用逗号分隔，系统会自动负载均衡</div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存配置
                  </button>
                </div>
              </form>
            </div>
          </div>
          
          <!-- 通用设置 -->
          <div class="tab-pane fade" id="general" role="tabpanel" aria-labelledby="general-tab">
            <div class="config-card">
              <h5 class="card-title"><i class="bi bi-shield-lock"></i>代理设置</h5>
              <form id="proxyForm">
                <div class="mb-4">
                  <label for="proxyApiKey" class="form-label">代理API密钥</label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control" id="proxyApiKey" placeholder="">
                    <button type="button" class="api-key-toggle" data-target="proxyApiKey">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">客户端访问此代理时需要使用的API密钥，也是管理界面的登录密码</div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存配置
                  </button>
                </div>
              </form>
            </div>
            
            <div class="config-card">
              <h5 class="card-title"><i class="bi bi-speedometer2"></i>流式输出优化</h5>
              <form id="streamForm">
                <div class="row">
                  <div class="col-md-6 mb-4">
                    <label for="minDelay" class="form-label">最小延迟(毫秒)</label>
                    <input type="number" class="form-control" id="minDelay" min="0" max="100" step="1">
                    <div class="form-text">字符间最小延迟时间，影响输出速度</div>
                  </div>
                  
                  <div class="col-md-6 mb-4">
                    <label for="maxDelay" class="form-label">最大延迟(毫秒)</label>
                    <input type="number" class="form-control" id="maxDelay" min="1" max="500" step="1">
                    <div class="form-text">字符间最大延迟时间，影响输出速度</div>
                  </div>
                </div>
                
                <div class="row">
                  <div class="col-md-6 mb-4">
                    <label for="adaptiveDelayFactor" class="form-label">自适应延迟因子</label>
                    <input type="number" class="form-control" id="adaptiveDelayFactor" min="0" max="2" step="0.1">
                    <div class="form-text">延迟自适应调整因子，值越大延迟变化越明显</div>
                  </div>
                  
                  <div class="col-md-6 mb-4">
                    <label for="chunkBufferSize" class="form-label">块缓冲区大小</label>
                    <input type="number" class="form-control" id="chunkBufferSize" min="1" max="50" step="1">
                    <div class="form-text">计算平均响应大小的缓冲区大小</div>
                  </div>
                </div>
                
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存配置
                  </button>
                </div>
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
                // 未授权，跳转到登录页面
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
        
        // 密钥显示/隐藏切换功能
        document.querySelectorAll('.api-key-toggle').forEach(button => {
          button.addEventListener('click', function() {
            const targetId = this.getAttribute('data-target');
            const inputField = document.getElementById(targetId);
            const icon = this.querySelector('i');
            
            if (inputField.type === 'password') {
              inputField.type = 'text';
              icon.classList.remove('bi-eye');
              icon.classList.add('bi-eye-slash');
            } else {
              inputField.type = 'password';
              icon.classList.remove('bi-eye-slash');
              icon.classList.add('bi-eye');
            }
          });
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

// 遮盖API密钥，仅显示前几位和后几位
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
      try {
        upstreamRequest = await createGeminiRequest(request, requestBody, config);
        console.log("Gemini请求URL:", upstreamRequest.url);
        // 由于现在upstreamRequest是普通对象，直接打印请求体
        console.log("Gemini请求体:", upstreamRequest.body);
      } catch (error) {
        console.error("创建Gemini请求时出错:", error);
        throw error;
      }
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
    
    // 使用nativeFetch发送请求到上游API
    const upstreamResponse = await nativeFetch(upstreamRequest, upstreamRequest.url);
    
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
    
    const upstreamRequest = {
      method: "GET",
      headers: new Headers({
        "Authorization": `Bearer ${outgoingApiKey}`,
        "Content-Type": "application/json"
      }),
      url: `${upstreamUrl}/v1/models`
    };
    
    const response = await nativeFetch(upstreamRequest, upstreamRequest.url);
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
      // 创建基本请求对象
      const modelRequest = {
        method: "GET",
        headers: new Headers({
          "Content-Type": "application/json"
        }),
        url: modelListUrl
      };
      
      const response = await nativeFetch(modelRequest, modelListUrl);
      
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
    } catch (error) {
      console.error("Error fetching Gemini models:", error);
    }
    
    // 如果请求失败或没有模型,则返回预设的模型列表
    return {
      object: "list",
      data: [
        {
          id: "gemini-1.5-pro-latest",
          object: "model",
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: "google"
        },
        {
          id: "gemini-1.5-flash-latest",
          object: "model",
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: "google"
        },
        {
          id: "gemini-pro-vision",
          object: "model",
          created: Math.floor(Date.now() / 1000) - 86400 * 60,
          owned_by: "google"
        }
      ]
    };
  } catch (error) {
    console.error("Error in Gemini models function:", error);
    return { object: "list", data: [] };
  }
}

// 获取Anthropic模型列表
async function getAnthropicModels(request, config) {
  try {
    // 确保Anthropic功能已启用且有API密钥
    if (!config.anthropicEnabled) {
      return { object: "list", data: [] };
    }
    
    const apiKey = getAnthropicApiKey(request, config);
    if (!apiKey) {
      return { object: "list", data: [] };
    }
    
    // 尝试动态获取Anthropic模型
    try {
      // 创建请求对象
      const modelRequest = {
        method: "GET",
        headers: new Headers({
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        }),
        url: `${config.anthropicUpstreamUrl}/v1/models`
      };
      
      const response = await nativeFetch(modelRequest, modelRequest.url);
      
      if (response.ok) {
        const anthropicModels = await response.json();
        
        if (anthropicModels && anthropicModels.data) {
          // 将Anthropic响应格式转换为OpenAI格式
          return {
            object: "list",
            data: anthropicModels.data.map(model => ({
              id: model.id,
              object: "model",
              created: Math.floor(Date.now() / 1000) - 86400 * 30, // 近似创建时间
              owned_by: "anthropic"
            }))
          };
        }
      }
    } catch (error) {
      console.error("Error fetching Anthropic models:", error);
    }
    
    // 如果动态获取失败,使用预设模型列表
    return {
      object: "list",
      data: [
        {
          id: "claude-3-opus-20240229",
          object: "model",
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: "anthropic"
        },
        {
          id: "claude-3-sonnet-20240229",
          object: "model",
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: "anthropic"
        },
        {
          id: "claude-3-haiku-20240307",
          object: "model",
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: "anthropic"
        },
        {
          id: "claude-3-5-sonnet-20240620",
          object: "model",
          created: Math.floor(Date.now() / 1000) - 86400 * 7,
          owned_by: "anthropic"
        }
      ]
    };
  } catch (error) {
    console.error("Error in Anthropic models function:", error);
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
  
  // 返回准备好的请求数据，而不是创建一个Request对象
  // 这样nativeFetch可以直接使用这些数据，而不是尝试解析Request对象
  requestInit.url = url;
  return requestInit;
}

// 创建Gemini API请求
async function createGeminiRequest(originalRequest, requestBody, config) {
  const apiKey = getGeminiApiKey(originalRequest, config);
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-goog-api-client": "genai-js/0.21.0",
    "x-goog-api-key": apiKey
  });

  let modelName = requestBody.model || "gemini-1.5-pro-latest";
  if (!modelName.startsWith("models/")) {
    modelName = `models/${modelName}`;
  }

  let geminiUrl = config.geminiUpstreamUrl;
  if (geminiUrl.endsWith('/')) {
    geminiUrl = geminiUrl.slice(0, -1);
  }

  const isStreamRequest = requestBody.stream === true;
  const TASK = isStreamRequest ? "streamGenerateContent" : "generateContent";
  let url = `${geminiUrl}/v1beta/${modelName}:${TASK}`;
  if (isStreamRequest) {
    url += "?alt=sse";
  }

  // 转换消息格式
  const contents = [];
  let system_instruction;
  
  for (const msg of requestBody.messages) {
    if (msg.role === "system") {
      system_instruction = {
        parts: [{ text: msg.content }]
      };
    } else {
      // 检查消息内容是否为对象数组（多模态内容）
      if (Array.isArray(msg.content)) {
        const parts = [];
        
        for (const contentItem of msg.content) {
          if (contentItem.type === 'text') {
            parts.push({ text: contentItem.text });
          } else if (contentItem.type === 'image_url') {
            // 处理图片URL
            let imageData = contentItem.image_url.url;
            
            // 如果是base64格式的图片
            if (imageData.startsWith('data:image/')) {
              const base64Data = imageData.split(',')[1];
              parts.push({
                inline_data: {
                  data: base64Data,
                  mime_type: imageData.split(';')[0].split(':')[1]
                }
              });
            } else {
              // 如果是普通URL
              parts.push({ 
                inline_data: {
                  data: imageData,
                  mime_type: "application/octet-stream"
                }
              });
            }
          }
        }
        
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: parts
        });
      } else {
        // 处理纯文本消息
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }]
        });
      }
    }
  }

  // 配置生成参数
  const generationConfig = {
    temperature: requestBody.temperature ?? 0.9,
    maxOutputTokens: requestBody.max_tokens || 8192,
    topP: requestBody.top_p ?? 0.95,
    topK: requestBody.top_k ?? 64,
    presencePenalty: requestBody.presence_penalty,
    frequencyPenalty: requestBody.frequency_penalty
  };

  // 准备Gemini请求体
  const geminiBody = {
    contents: contents,
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ],
    generationConfig
  };

  // 如果有系统指令,添加到请求
  if (system_instruction) {
    geminiBody.systemInstruction = system_instruction;
  }

  // 返回请求对象
  return {
    method: "POST",
    headers: headers,
    body: JSON.stringify(geminiBody),
    url: url,
    redirect: "follow"
  };
}

// 创建Anthropic API请求
async function createAnthropicRequest(originalRequest, requestBody, config) {
  const apiKey = getAnthropicApiKey(originalRequest, config);
  
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  });

  let anthropicUrl = config.anthropicUpstreamUrl;
  if (anthropicUrl.endsWith('/')) {
    anthropicUrl = anthropicUrl.slice(0, -1);
  }

  // 转换请求格式为Anthropic格式
  const anthropicBody = convertToAnthropicFormat(requestBody);
  
  return {
    method: "POST",
    headers: headers,
    body: JSON.stringify(anthropicBody),
    url: `${anthropicUrl}/v1/messages`,
    redirect: "follow"
  };
}

// OpenAI格式转换为Gemini格式
function convertToGeminiFormat(openAiBody) {
  const geminiBody = {
    contents: [],
    generationConfig: {}
  };
  
  // 设置生成参数
  if (openAiBody.temperature !== undefined) {
    geminiBody.generationConfig.temperature = openAiBody.temperature;
  }
  if (openAiBody.max_tokens !== undefined) {
    geminiBody.generationConfig.maxOutputTokens = openAiBody.max_tokens;
  }
  if (openAiBody.top_p !== undefined) {
    geminiBody.generationConfig.topP = openAiBody.top_p;
  }
  
  // 处理模型名称
  const modelMap = {
    "gpt-3.5-turbo": "gemini-pro",
    "gpt-4": "gemini-1.5-pro",
    "gpt-4-turbo": "gemini-1.5-pro",
  };
  
  geminiBody.model = openAiBody.model && openAiBody.model.toString().startsWith("gemini") 
    ? openAiBody.model 
    : (modelMap[openAiBody.model] || "gemini-pro");
  
  // 处理消息
  if (openAiBody.messages && Array.isArray(openAiBody.messages)) {
    // 处理每条消息，保留原始结构
    let currentUserParts = [];
    let currentRole = null;
    
    for (const msg of openAiBody.messages) {
      // 跳过系统消息，因为已在前面处理
      if (msg.role === "system") continue;
      
      const role = msg.role === "assistant" ? "model" : "user";
      
      // 如果角色变化，添加前一个消息并重置
      if (currentRole !== null && currentRole !== role && currentUserParts.length > 0) {
        geminiBody.contents.push({
          role: currentRole,
          parts: currentUserParts
        });
        currentUserParts = [];
      }
      
      currentRole = role;
      
      // 处理消息内容
      if (Array.isArray(msg.content)) {
        // 多模态内容
        for (const contentItem of msg.content) {
          if (contentItem.type === 'text') {
            currentUserParts.push({ text: contentItem.text });
          } else if (contentItem.type === 'image_url') {
            // 处理图片URL
            let imageData = contentItem.image_url.url;
            
            // 如果是base64格式的图片
            if (imageData.startsWith('data:image/')) {
              const base64Data = imageData.split(',')[1];
              currentUserParts.push({
                inline_data: {
                  data: base64Data,
                  mime_type: imageData.split(';')[0].split(':')[1]
                }
              });
            } else {
              // 如果是普通URL
              currentUserParts.push({ 
                inline_data: {
                  data: imageData,
                  mime_type: "application/octet-stream"
                }
              });
            }
          }
        }
      } else {
        // 纯文本内容
        currentUserParts.push({ text: msg.content });
      }
    }
    
    // 添加最后一组消息
    if (currentRole !== null && currentUserParts.length > 0) {
      geminiBody.contents.push({
        role: currentRole,
        parts: currentUserParts
      });
    }
  }
  
  // 调试日志
  console.log("转换后的Gemini请求体:", JSON.stringify(geminiBody, null, 2));
  
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
      await writer.write(encoder.encode("n"));
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

  if (line.startsWith("data: ")) {
    const data = line.slice(6);
    console.log("Gemini原始数据:", data);

    if (data === "[DONE]") {
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      return;
    }

    try {
      const geminiData = JSON.parse(data);
      console.log("解析后的Gemini数据:", JSON.stringify(geminiData, null, 2));

      if (geminiData.candidates && geminiData.candidates.length > 0) {
        const candidate = geminiData.candidates[0];
        const index = candidate.index || 0;

        // 提取文本内容
        let textContent = "";
        if (candidate.content?.parts) {
          textContent = candidate.content.parts
            .filter(part => part.text)
            .map(part => part.text)
            .join("");
        }

        if (textContent) {
          // 创建OpenAI格式的响应对象
          const openAIFormat = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-pro",
            choices: [{
              index,
              delta: {
                content: textContent
              },
              finish_reason: null
            }]
          };

          // 使用sendContentCharByChar函数处理流式输出
          await sendContentCharByChar(textContent, openAIFormat, writer, encoder, delay, false);
        }

        // 如果有完成原因，发送最终块
        if (candidate.finishReason) {
          const reasonsMap = {
            "STOP": "stop",
            "MAX_TOKENS": "length",
            "SAFETY": "content_filter",
            "RECITATION": "content_filter"
          };

          const finalChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "gemini-pro",
            choices: [{
              index,
              delta: {},
              finish_reason: reasonsMap[candidate.finishReason] || candidate.finishReason
            }]
          };

          await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          await writer.write(encoder.encode("data: [DONE]\n\n"));
        }
      }

    } catch (e) {
      console.error("解析Gemini SSE出错:", e, "原始数据:", data);
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    }
  } else {
    console.log("非data行:", line);
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
    await writer.write(encoder.encode(`data: ${JSON.stringify(charResponse)}\n\n`));
    
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
