/**
 * 多提供商AI API兼容代理
 * 支持OpenAI、Anthropic、Gemini格式的API
 * 自动检测模型类型路由到相应API
 * 实现多API密钥负载均衡
 * 智能字符流式输出优化
 * 美观的Web管理界面
 * https://github.com/GeorgeXie2333/LLM-Stream-Optimizer
 */

// 生成UUID的函数，用于唯一标识端点
function generateUUID() {
  // 简化版UUID实现
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// KV配置键名
const KV_CONFIG_KEYS = {
  UPSTREAM_URL: "upstream_url",
  OUTGOING_API_KEY: "outgoing_api_key",
  OPENAI_ENDPOINTS: "openai_endpoints", // 新增: 存储多个OpenAI端点的配置
  GEMINI_URL: "gemini_url",
  GEMINI_API_KEY: "gemini_api_key",
  GEMINI_USE_NATIVE_FETCH: "gemini_use_native_fetch",
  ANTHROPIC_URL: "anthropic_url",
  ANTHROPIC_API_KEY: "anthropic_api_key",
  ANTHROPIC_USE_NATIVE_FETCH: "anthropic_use_native_fetch",
  PROXY_API_KEY: "proxy_api_key",
  // 字符延迟参数
  MIN_DELAY: "min_delay",
  MAX_DELAY: "max_delay",
  ADAPTIVE_DELAY_FACTOR: "adaptive_delay_factor",
  CHUNK_BUFFER_SIZE: "chunk_buffer_size",
  DISABLE_OPTIMIZATION_MODELS: "disable_optimization_models",
  // 新增的流式优化参数
  MIN_CONTENT_LENGTH_FOR_FAST_OUTPUT: "min_content_length_for_fast_output",
  FAST_OUTPUT_DELAY: "fast_output_delay",
  FINAL_LOW_DELAY: "final_low_delay"
};

// 默认配置
const DEFAULT_CONFIG = {
  // 字符间延迟参数
  minDelay: 5,              // 最小延迟(毫秒)
  maxDelay: 40,             // 最大延迟(毫秒)
  adaptiveDelayFactor: 0.5, // 自适应延迟因子
  chunkBufferSize: 10,       // 计算平均响应大小的缓冲区大小

  // 新的流优化参数
  minContentLengthForFastOutput: 10000, // 内容长度超过此值时启用快速输出
  fastOutputDelay: 3, // 快速输出时的固定延迟
  finalLowDelay: 1, // 模型完成响应后的低延迟

  // OpenAI多端点配置
  openaiEndpoints: [],      // 多个OpenAI端点的配置列表
};

// 预定义模型前缀映射到API类型
const MODEL_PREFIX_MAP = {
  'claude-': 'anthropic',
  'gemini-': 'gemini'
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
    
    // 确保req.headers是可迭代的Headers对象
    try {
      for (const [k, v] of req.headers) {
        if (!HEADER_FILTER_RE.test(k)) {
          cleanedHeaders.set(k, v);
        }
      }
    } catch (headerError) {
      console.error("处理请求头时出错:", headerError);
      console.log("尝试替代方法处理headers");
      
      // 如果标准迭代失败，尝试其他方法获取所有头
      const headerNames = req.headers.keys ? Array.from(req.headers.keys()) : [];
      for (const k of headerNames) {
        if (!HEADER_FILTER_RE.test(k)) {
          const v = req.headers.get(k);
          if (v !== null && v !== undefined) {
            cleanedHeaders.set(k, v);
          }
        }
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
        safeHeadersToString(cleanedHeaders) +
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
        safeHeadersToString(cleanedHeaders) +
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
    
    // 处理不同类型的headers对象
    if (headers instanceof Headers) {
      // 标准Headers对象
      for (const [k, v] of headers.entries()) {
        if (!HEADER_FILTER_RE.test(k)) {
          cleanedHeaders.set(k, v);
        }
      }
    } else if (typeof headers === 'object') {
      // 普通对象，例如 {key: value}
      for (const [k, v] of Object.entries(headers)) {
        if (!HEADER_FILTER_RE.test(k)) {
          cleanedHeaders.set(k, v);
        }
      }
    } else {
      console.warn("不支持的headers类型:", typeof headers);
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
      safeHeadersToString(cleanedHeaders) +
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
            config.defaultEnabled = !!value;
            break;
          case "OPENAI_ENDPOINTS":
            try {
              const endpoints = JSON.parse(value);
              if (Array.isArray(endpoints)) {
                config.openaiEndpoints = endpoints;
              }
            } catch (e) {
              console.error("解析OpenAI端点配置出错:", e);
            }
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
          case "GEMINI_USE_NATIVE_FETCH":
            config.geminiUseNativeFetch = value === "true";
            break;
          case "ANTHROPIC_USE_NATIVE_FETCH":
            config.anthropicUseNativeFetch = value === "true";
            break;
          case "DISABLE_OPTIMIZATION_MODELS":
            config.disableOptimizationModels = JSON.parse(value);
            break;
          case "MIN_CONTENT_LENGTH_FOR_FAST_OUTPUT":
            config.minContentLengthForFastOutput = parseInt(value) || DEFAULT_CONFIG.minContentLengthForFastOutput;
            break;
          case "FAST_OUTPUT_DELAY":
            config.fastOutputDelay = parseInt(value) || DEFAULT_CONFIG.fastOutputDelay;
            break;
          case "FINAL_LOW_DELAY":
            config.finalLowDelay = parseInt(value) || DEFAULT_CONFIG.finalLowDelay;
            break;
        }
      }
    });
    
    // 等待所有KV读取完成
    await Promise.all(promises);
    
    // 如果KV中没有某些配置，则使用环境变量作为后备
    config.defaultUpstreamUrl = config.defaultUpstreamUrl || env.UPSTREAM_URL || "https://api.openai.com/v1";
    config.defaultOutgoingApiKey = config.defaultOutgoingApiKey || env.OPENAI_API_KEY || "";
    
    // 如果环境变量中有定义多个OpenAI端点，则加载它们
    if (env.OPENAI_ENDPOINTS) {
      try {
        const envEndpoints = JSON.parse(env.OPENAI_ENDPOINTS);
        if (Array.isArray(envEndpoints) && envEndpoints.length > 0) {
          config.openaiEndpoints = envEndpoints;
        }
      } catch (e) {
        console.error("解析环境变量中的OpenAI端点配置出错:", e);
      }
    }
    
    // 如果没有配置任何多端点，但配置了默认端点和API密钥，则添加默认端点
    if (config.openaiEndpoints.length === 0 && config.defaultUpstreamUrl && config.defaultOutgoingApiKey) {
      config.openaiEndpoints.push({
        id: generateUUID(), // 添加唯一ID
        name: "默认端点",
        url: config.defaultUpstreamUrl,
        apiKey: config.defaultOutgoingApiKey,
        models: ["gpt-3.5-turbo", "gpt-4"]
      });
    }
    
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
  const config = {
    ...DEFAULT_CONFIG,
    // OpenAI配置
    defaultUpstreamUrl: env.UPSTREAM_URL || "https://api.openai.com/v1",
    defaultOutgoingApiKey: env.OPENAI_API_KEY || "", // 默认API密钥
    
    // Gemini配置
    geminiEnabled: !!env.GEMINI_API_KEY,
    geminiUpstreamUrl: env.GEMINI_URL || "https://generativelanguage.googleapis.com",
    geminiApiKey: env.GEMINI_API_KEY || "",
    geminiUseNativeFetch: env.GEMINI_USE_NATIVE_FETCH !== "false", // 默认开启，只有明确设置为"false"才关闭
    
    // Anthropic配置
    anthropicEnabled: !!env.ANTHROPIC_API_KEY,
    anthropicUpstreamUrl: env.ANTHROPIC_URL || "https://api.anthropic.com",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    anthropicUseNativeFetch: env.ANTHROPIC_USE_NATIVE_FETCH !== "false", // 默认开启，只有明确设置为"false"才关闭
    
    // 代理控制配置
    proxyApiKey: env.PROXY_API_KEY || "",  // 代理服务自身的API密钥
  };
  
  // 尝试加载多端点配置
  if (env.OPENAI_ENDPOINTS) {
    try {
      const endpoints = JSON.parse(env.OPENAI_ENDPOINTS);
      if (Array.isArray(endpoints)) {
        config.openaiEndpoints = endpoints;
      }
    } catch (e) {
      console.error("解析环境变量中的OpenAI端点配置出错:", e);
    }
  }
  
  // 如果没有多端点配置，但有默认端点，则创建一个默认端点配置
  if ((!config.openaiEndpoints || config.openaiEndpoints.length === 0) && config.defaultOutgoingApiKey) {
    config.openaiEndpoints = [{
      name: "默认",
      url: config.defaultUpstreamUrl,
      apiKey: config.defaultOutgoingApiKey,
      models: [] // 空数组表示支持所有模型
    }];
  }
  
  return config;
}

// 将配置保存到KV存储
async function saveConfigToKV(env, config) {
  if (!env.CONFIG_KV) {
    return { success: false, message: "未检测到KV绑定，无法保存配置" };
  }

  try {
    // 先读取当前KV中的配置
    const currentConfig = await loadConfigFromKV(env);
    
    // 准备需要更新的配置列表
    const updatePromises = [];
    
    // 比较并只更新有变化的配置项
    if (config.defaultUpstreamUrl !== currentConfig.defaultUpstreamUrl) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.UPSTREAM_URL, config.defaultUpstreamUrl || ""));
    }
    
    if (config.defaultOutgoingApiKey !== currentConfig.defaultOutgoingApiKey) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.OUTGOING_API_KEY, config.defaultOutgoingApiKey || ""));
    }
    
    // 对于JSON数据，需要特殊处理
    const newEndpointsJSON = JSON.stringify(config.openaiEndpoints || []);
    const currentEndpointsJSON = JSON.stringify(currentConfig.openaiEndpoints || []);
    if (newEndpointsJSON !== currentEndpointsJSON) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.OPENAI_ENDPOINTS, newEndpointsJSON));
    }
    
    if (config.geminiUpstreamUrl !== currentConfig.geminiUpstreamUrl) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.GEMINI_URL, config.geminiUpstreamUrl || ""));
    }
    
    if (config.geminiApiKey !== currentConfig.geminiApiKey) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.GEMINI_API_KEY, config.geminiApiKey || ""));
    }
    
    if ((!!config.geminiUseNativeFetch).toString() !== (!!currentConfig.geminiUseNativeFetch).toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.GEMINI_USE_NATIVE_FETCH, (!!config.geminiUseNativeFetch).toString()));
    }
    
    if (config.anthropicUpstreamUrl !== currentConfig.anthropicUpstreamUrl) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.ANTHROPIC_URL, config.anthropicUpstreamUrl || ""));
    }
    
    if (config.anthropicApiKey !== currentConfig.anthropicApiKey) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.ANTHROPIC_API_KEY, config.anthropicApiKey || ""));
    }
    
    if ((!!config.anthropicUseNativeFetch).toString() !== (!!currentConfig.anthropicUseNativeFetch).toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.ANTHROPIC_USE_NATIVE_FETCH, (!!config.anthropicUseNativeFetch).toString()));
    }
    
    if (config.proxyApiKey !== currentConfig.proxyApiKey) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.PROXY_API_KEY, config.proxyApiKey || ""));
    }
    
    if (config.minDelay.toString() !== currentConfig.minDelay.toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.MIN_DELAY, config.minDelay.toString()));
    }
    
    if (config.maxDelay.toString() !== currentConfig.maxDelay.toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.MAX_DELAY, config.maxDelay.toString()));
    }
    
    if (config.adaptiveDelayFactor.toString() !== currentConfig.adaptiveDelayFactor.toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.ADAPTIVE_DELAY_FACTOR, config.adaptiveDelayFactor.toString()));
    }
    
    if (config.chunkBufferSize.toString() !== currentConfig.chunkBufferSize.toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.CHUNK_BUFFER_SIZE, config.chunkBufferSize.toString()));
    }
    
    // 对于数组，需要特殊处理
    const newDisableModelsJSON = JSON.stringify(config.disableOptimizationModels || []);
    const currentDisableModelsJSON = JSON.stringify(currentConfig.disableOptimizationModels || []);
    if (newDisableModelsJSON !== currentDisableModelsJSON) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.DISABLE_OPTIMIZATION_MODELS, newDisableModelsJSON));
    }
    
    if (config.minContentLengthForFastOutput.toString() !== currentConfig.minContentLengthForFastOutput.toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.MIN_CONTENT_LENGTH_FOR_FAST_OUTPUT, config.minContentLengthForFastOutput.toString()));
    }
    
    if (config.fastOutputDelay.toString() !== currentConfig.fastOutputDelay.toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.FAST_OUTPUT_DELAY, config.fastOutputDelay.toString()));
    }
    
    if (config.finalLowDelay.toString() !== currentConfig.finalLowDelay.toString()) {
      updatePromises.push(env.CONFIG_KV.put(KV_CONFIG_KEYS.FINAL_LOW_DELAY, config.finalLowDelay.toString()));
    }
    
    // 执行所有需要更新的配置项
    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
      return { success: true, message: `配置保存成功，共更新了 ${updatePromises.length} 项设置` };
    } else {
      return { success: true, message: "配置无变化，无需更新" };
    }
  } catch (error) {
    console.error("保存配置到KV时出错:", error);
    return { success: false, message: `配置保存失败: ${error.message}` };
  }
}

// 处理管理页面请求
async function handleAdminRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 检查是否有有效的会话令牌
  const isLoggedIn = await checkAdminSession(request, env);
  
  // 保护所有管理页面，登录API除外
  if (path.startsWith('/admin/') && 
      path !== '/admin/' && 
      path !== '/admin/api/login') {
    // 如果未登录，重定向到登录页面或返回401
    if (!isLoggedIn) {
      // 对API请求返回401，对页面请求重定向
      if (path.includes('/api/')) {
        return new Response(JSON.stringify({ success: false, message: "未授权" }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        return Response.redirect(`${url.origin}/admin`, 302);
      }
    }
  }
  
  if (path === '/admin/dashboard') {
    // 已经验证了登录状态，直接提供仪表盘
    return serveDashboardPage();
  }
  
  // 提供登录页面
  if (path === '/admin' || path === '/admin/') {
    // 检查是否已登录
    const isLoggedIn = await checkAdminSession(request, env);
    
    if (isLoggedIn) {
      // 如果已登录，重定向到仪表盘
      return Response.redirect(`${url.origin}/admin/dashboard`, 302);
    }
    
    // 未登录则提供登录页面
    return serveLoginPage();
  }
  
  // 处理API请求
  if (path === '/admin/api/login') {
    return handleLoginRequest(request, env);
  }
  
  if (path === '/admin/api/logout') {
    return handleLogoutRequest(request, env);
  }
  
  if (path === '/admin/api/check-session') {
    return handleCheckSessionRequest(request, env);
  }
  
  if (path === '/admin/api/config') {
    return handleConfigApiRequest(request, env);
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
    
    if (!sessionToken || sessionToken.trim() === '') {
      console.log("没有找到管理员会话token或token为空");
      return false;
    }
    
    // 验证会话令牌
    const config = await loadConfigFromKV(env);
    
    // 如果没有配置API密钥，拒绝所有请求
    if (!config.proxyApiKey) {
      console.log("未配置proxyApiKey，会话无效");
      return false;
    }
    
    const expectedToken = await sha256(config.proxyApiKey || "");
    
    // 确保token完全匹配
    const isValid = sessionToken === expectedToken;
    
    if (!isValid) {
      console.log("管理员会话token无效");
    }
    
    return isValid;
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
        'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure`
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
        defaultEnabled: config.defaultEnabled,
        openaiEndpoints: config.openaiEndpoints ? config.openaiEndpoints.map(endpoint => ({
          name: endpoint.name,
          url: endpoint.url,
          apiKey: maskAPIKey(endpoint.apiKey),
          models: endpoint.models,
          useNativeFetch: endpoint.useNativeFetch !== undefined ? endpoint.useNativeFetch : true
        })) : [],
        geminiEnabled: config.geminiEnabled,
        geminiUpstreamUrl: config.geminiUpstreamUrl,
        geminiApiKey: maskAPIKey(config.geminiApiKey),
        geminiUseNativeFetch: config.geminiUseNativeFetch === true,
        anthropicEnabled: config.anthropicEnabled,
        anthropicUpstreamUrl: config.anthropicUpstreamUrl,
        anthropicApiKey: maskAPIKey(config.anthropicApiKey),
        anthropicUseNativeFetch: config.anthropicUseNativeFetch === true,
        proxyApiKey: maskAPIKey(config.proxyApiKey),
        minDelay: config.minDelay,
        maxDelay: config.maxDelay,
        adaptiveDelayFactor: config.adaptiveDelayFactor,
        chunkBufferSize: config.chunkBufferSize,
        disableOptimizationModels: config.disableOptimizationModels || [],
        minContentLengthForFastOutput: config.minContentLengthForFastOutput,
        fastOutputDelay: config.fastOutputDelay,
        finalLowDelay: config.finalLowDelay
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
        geminiUseNativeFetch: body.hasOwnProperty('geminiUseNativeFetch') ? !!body.geminiUseNativeFetch : currentConfig.geminiUseNativeFetch,
        anthropicUseNativeFetch: body.hasOwnProperty('anthropicUseNativeFetch') ? !!body.anthropicUseNativeFetch : currentConfig.anthropicUseNativeFetch,
        minDelay: parseInt(body.minDelay) || currentConfig.minDelay,
        maxDelay: parseInt(body.maxDelay) || currentConfig.maxDelay,
        adaptiveDelayFactor: parseFloat(body.adaptiveDelayFactor) || currentConfig.adaptiveDelayFactor,
        chunkBufferSize: parseInt(body.chunkBufferSize) || currentConfig.chunkBufferSize,
        minContentLengthForFastOutput: parseInt(body.minContentLengthForFastOutput) || currentConfig.minContentLengthForFastOutput,
        fastOutputDelay: parseInt(body.fastOutputDelay) || currentConfig.fastOutputDelay,
        finalLowDelay: parseInt(body.finalLowDelay) || currentConfig.finalLowDelay
      };
      
      // 更新禁用流式优化的模型列表
      if (body.hasOwnProperty('disableOptimizationModels') && Array.isArray(body.disableOptimizationModels)) {
        newConfig.disableOptimizationModels = body.disableOptimizationModels
          .filter(model => typeof model === 'string' && model.trim());
      }
      
      // 仅更新非空API密钥（防止覆盖现有密钥）
      if (body.defaultOutgoingApiKey && !body.defaultOutgoingApiKey.includes('*')) {
        newConfig.defaultOutgoingApiKey = body.defaultOutgoingApiKey;
        newConfig.defaultEnabled = true;
      } else if (body.hasOwnProperty('defaultOutgoingApiKey') && body.defaultOutgoingApiKey === '') {
        newConfig.defaultOutgoingApiKey = '';
        newConfig.defaultEnabled = false;
      }
      
      // 处理多端点配置
      if (body.hasOwnProperty('openaiEndpoints') && Array.isArray(body.openaiEndpoints)) {
        // 处理每个端点的API密钥，保留非屏蔽的密钥
        const endpoints = body.openaiEndpoints.map(endpoint => {
          // 如果API密钥被屏蔽了，尝试从现有配置中找到对应的端点
          if (endpoint.apiKey && endpoint.apiKey.includes('*')) {
            // 尝试在现有配置中找到匹配的端点
            // 优先使用ID匹配，如果没有ID或找不到再使用名称和URL匹配
            let existingEndpoint;
            if (endpoint.id) {
              existingEndpoint = currentConfig.openaiEndpoints?.find(e => e.id === endpoint.id);
            }
            
            // 如果没有通过ID找到，则通过名称和URL匹配
            if (!existingEndpoint) {
              existingEndpoint = currentConfig.openaiEndpoints?.find(e => 
                e.name === endpoint.name && e.url === endpoint.url);
            }
            
            // 如果找到匹配的端点，使用现有的API密钥
            if (existingEndpoint) {
              return {
                ...endpoint,
                apiKey: existingEndpoint.apiKey
              };
            }
          }
          return endpoint;
        });
        
        newConfig.openaiEndpoints = endpoints.filter(e => e.url && e.apiKey);
      }
      
      if (body.geminiApiKey && !body.geminiApiKey.includes('*')) {
        newConfig.geminiApiKey = body.geminiApiKey;
        newConfig.geminiEnabled = true;
      } else if (body.hasOwnProperty('geminiApiKey') && body.geminiApiKey === '') {
        newConfig.geminiApiKey = '';
        newConfig.geminiEnabled = false;
      }
      
      if (body.anthropicApiKey && !body.anthropicApiKey.includes('*')) {
        newConfig.anthropicApiKey = body.anthropicApiKey;
        newConfig.anthropicEnabled = true;
      } else if (body.hasOwnProperty('anthropicApiKey') && body.anthropicApiKey === '') {
        newConfig.anthropicApiKey = '';
        newConfig.anthropicEnabled = false;
      }
      
      if (body.proxyApiKey && !body.proxyApiKey.includes('*')) {
        newConfig.proxyApiKey = body.proxyApiKey;
      } else if (body.hasOwnProperty('proxyApiKey') && body.proxyApiKey === '') {
        newConfig.proxyApiKey = '';
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
      <title>LLM Stream Optimizer - 管理登录</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --primary-color: #4361ee; /* 鲜艳蓝 */
          --primary-hover: #3a55cf; /* 深一点的蓝 */
          --secondary-color: #7209b7; /* 紫色 */
          --accent-color: #4cc9f0; /* 青色 */
          --success-color: #06d6a0; /* 鲜艳绿 */
          --warning-color: #ffd166; /* 黄色 */
          --danger-color: #ef476f; /* 红色 */
          --light-bg: #f8f9fa;
          --dark-bg: #2b2d42; /* 深灰蓝 */
          --card-bg: rgba(255, 255, 255, 0.9); /* 轻微透明白色 */
          --dark-text: #2b2d42;
          --light-text: #8d99ae; /* 灰色 */
          --card-shadow: 0 15px 35px rgba(67, 97, 238, 0.1), 0 5px 15px rgba(0, 0, 0, 0.07); /* 更柔和的阴影 */
          --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        body {
          background: linear-gradient(135deg, #f5f7fa 0%, #e5e9f2 100%); /* 淡雅背景渐变 */
          font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--dark-text);
          margin: 0;
          padding: 20px;
          position: relative;
          overflow: hidden; /* 隐藏超出部分的伪元素 */
        }
        /* 背景装饰图形 */
        body::before, body::after {
          content: '';
          position: absolute;
          border-radius: 50%;
          background: linear-gradient(135deg, rgba(67, 97, 238, 0.08), rgba(114, 9, 183, 0.08)); /* 更淡的渐变 */
          z-index: -1;
          filter: blur(50px); /* 模糊效果 */
        }
        body::before {
          width: 500px;
          height: 500px;
          top: -150px;
          right: -150px;
        }
        body::after {
          width: 400px;
          height: 400px;
          bottom: -100px;
          left: -100px;
          background: linear-gradient(135deg, rgba(76, 201, 240, 0.08), rgba(67, 97, 238, 0.08));
        }
        .login-container {
          width: 90%;
          max-width: 450px;
          padding: 3rem;
          background-color: var(--card-bg);
          border-radius: 16px; /* 更圆润的边角 */
          box-shadow: var(--card-shadow);
          transform: translateY(0);
          transition: var(--transition);
          position: relative;
          overflow: hidden; /* 隐藏内部溢出的伪元素 */
          margin: 0 auto;
          backdrop-filter: blur(10px); /* 背景模糊效果 */
          -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.3); /* 细微边框增加质感 */
        }
        .login-container:hover {
          transform: translateY(-8px);
          box-shadow: 0 20px 40px rgba(67, 97, 238, 0.15), 0 8px 20px rgba(0, 0, 0, 0.1); /* 悬停时阴影加深 */
        }
        /* 顶部装饰条 */
        .login-container::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 6px;
          background: linear-gradient(90deg, var(--primary-color), var(--secondary-color));
        }
        .login-header {
          text-align: center;
          margin-bottom: 2.5rem;
        }
        .login-icon {
          font-size: 3rem;
          /* 应用渐变色到图标 */
          background: linear-gradient(120deg, var(--primary-color), var(--secondary-color));
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          margin-bottom: 1rem;
          display: inline-block;
        }
        .login-title {
          text-align: center;
          margin-bottom: 0.5rem;
          color: var(--dark-text);
          font-weight: 700;
          position: relative;
          letter-spacing: -0.5px;
        }
        .login-subtitle {
          color: var(--light-text);
          font-size: 0.95rem;
          margin-bottom: 0;
        }
        .form-group {
          margin-bottom: 1.5rem;
          position: relative;
        }
        .form-control {
          border: 1px solid #e9ecef; /* 更细的边框 */
          padding: 1rem 1.25rem;
          border-radius: 12px; /* 统一圆角 */
          transition: var(--transition);
          font-size: 0.95rem;
          background-color: rgba(249, 250, 251, 0.8); /* 轻微透明 */
        }
        .form-control:focus {
          border-color: var(--primary-color);
          box-shadow: 0 0 0 4px rgba(67, 97, 238, 0.15); /* 聚焦阴影 */
          background-color: #fff; /* 聚焦时变不透明 */
        }
        .form-control:hover {
          border-color: #d0d4d9; /* 悬停时边框颜色 */
        }
        .form-label {
          font-weight: 600;
          color: var(--dark-text);
          margin-bottom: 0.75rem;
          font-size: 0.95rem;
        }
        .form-text {
          color: var(--light-text);
          font-size: 0.85rem;
          margin-top: 0.5rem;
        }
        .btn-login {
          width: 100%;
          padding: 0.9rem;
          border-radius: 12px; /* 统一圆角 */
          background: linear-gradient(135deg, var(--primary-color), var(--primary-hover));
          border: none;
          font-weight: 600;
          font-size: 1rem;
          color: #fff;
          letter-spacing: 0.5px;
          box-shadow: 0 5px 15px rgba(67, 97, 238, 0.2);
          transition: var(--transition);
          position: relative; /* 为了伪元素定位 */
          overflow: hidden; /* 隐藏溢出的伪元素 */
          z-index: 1; /* 确保伪元素在内容之下 */
        }
        /* 按钮加载动画 */
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .btn-login .bi-arrow-repeat {
          display: inline-block;
          animation: spin 1.2s linear infinite;
        }
        .btn-login:hover {
          background: linear-gradient(135deg, var(--primary-hover), var(--secondary-color)); /* 悬停时渐变变化 */
          transform: translateY(-3px);
          box-shadow: 0 8px 25px rgba(67, 97, 238, 0.3); /* 悬停阴影加强 */
        }
        .btn-login:active {
          transform: translateY(-1px);
        }
        /* 按钮闪光效果 */
        .btn-login::after {
          content: '';
          position: absolute;
          top: -50%;
          left: -50%;
          width: 20%; /* 闪光条宽度 */
          height: 200%;
          background: linear-gradient(
            to right,
            rgba(255, 255, 255, 0) 0%,
            rgba(255, 255, 255, 0.5) 50%, /* 闪光亮度 */
            rgba(255, 255, 255, 0) 100%
          );
          transform: rotate(30deg); /* 闪光角度 */
          opacity: 0;
          transition: opacity 0.3s ease;
          z-index: 2; /* 确保在按钮内容之上 */
          pointer-events: none; /* 不干扰点击 */
        }
        .btn-login:hover::after {
          opacity: 1;
          animation: shine 1.5s ease-out; /* 调整动画速度和缓动 */
        }
        @keyframes shine {
          0% { left: -75%; top: -75%; } /* 调整起始位置 */
          100% { left: 120%; top: -25%; } /* 调整结束位置 */
        }
        /* 带图标的输入框 */
        .input-with-icon {
          position: relative;
        }
        .input-icon {
          position: absolute;
          left: 15px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--light-text);
          font-size: 1.2rem;
          pointer-events: none; /* 防止图标干扰输入 */
        }
        .input-with-icon .form-control {
          padding-left: 3rem; /* 为图标留出空间 */
        }
        /* 警告框样式 */
        .alert {
          border-radius: 12px; /* 统一圆角 */
          padding: 1rem 1.25rem; /* 调整内边距 */
          margin-bottom: 2rem;
          border: none;
          display: none;
          font-weight: 500;
          animation: slideDown 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55); /* 果冻效果入场 */
          box-shadow: 0 5px 20px rgba(0, 0, 0, 0.05);
        }
        /* 成功提示框特殊样式 */
        .alert-success {
          background-color: var(--success-color);
          color: white;
        }
        /* 错误提示框 */
        .alert-danger {
          background-color: var(--danger-color);
          color: white;
        }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-30px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        /* 响应式调整 */
        @media (max-width: 768px) {
          .login-container {
            padding: 2rem;
          }
        }
        @media (max-width: 480px) {
          .login-container {
            padding: 1.5rem;
          }
          .login-title {
            font-size: 1.5rem;
          }
          .login-icon {
            font-size: 2.5rem;
          }
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <div class="login-header">
          <i class="bi bi-braces-asterisk login-icon"></i>
          <h1 class="login-title">LLM Stream Optimizer</h1>
          <p class="login-subtitle">管理员登录</p>
        </div>

        <!-- 登录失败提示 -->
        <div id="loginAlert" class="alert alert-danger" role="alert">
          <i class="bi bi-exclamation-triangle-fill me-2"></i>
          <span id="alertMessage"></span>
        </div>

        <!-- 登录成功提示 -->
        <div id="successAlert" class="alert alert-success" role="alert" style="display: none;">
          <i class="bi bi-check-circle-fill me-2"></i>
          <span id="successMessage">登录成功！正在跳转...</span>
        </div>

        <form id="loginForm">
          <div class="form-group">
            <label for="password" class="form-label">管理员密码</label>
            <div class="input-with-icon">
              <i class="bi bi-shield-lock input-icon"></i>
              <input type="password" class="form-control" id="password" name="password" placeholder="请输入管理员密码" required autocomplete="current-password">
            </div>
            <div class="form-text">请输入代理API密钥作为管理员密码</div>
          </div>
          <div class="form-group mt-4"> <!-- 增加按钮与上方间距 -->
            <button type="submit" class="btn btn-login">
              <i class="bi bi-box-arrow-in-right me-2"></i>登录
            </button>
          </div>
        </form>
      </div>

      <script>
        // 页面加载时检查用户是否已登录
        window.addEventListener('load', async () => {
          try {
            const checkResponse = await fetch('/admin/api/check-session', {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' }
            });
            // 只有服务器确认会话有效才跳转
            if (checkResponse.ok && (await checkResponse.json()).isLoggedIn) {
              window.location.href = '/admin/dashboard';
            }
          } catch (error) {
            console.error('检查会话状态出错:', error);
            // 不显示错误，避免干扰未登录用户
          }
        });

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const password = document.getElementById('password').value;
          const loginButton = document.querySelector('.btn-login');
          const originalButtonContent = loginButton.innerHTML;
          const loginAlert = document.getElementById('loginAlert');
          const successAlert = document.getElementById('successAlert');
          const alertMessage = document.getElementById('alertMessage');

          // 隐藏所有提示
          loginAlert.style.display = 'none';
          successAlert.style.display = 'none';

          // 设置加载状态
          loginButton.innerHTML = '<i class="bi bi-arrow-repeat me-2"></i>登录中...';
          loginButton.disabled = true;

          try {
            const response = await fetch('/admin/api/login', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ password }),
            });
            const data = await response.json();

            if (response.ok && data.success) {
              // 显示成功弹窗
              successAlert.style.display = 'block';
              // 延迟跳转，让用户看到成功消息
              setTimeout(() => {
                window.location.href = '/admin/dashboard';
              }, 1500);
              // 成功后不需要恢复按钮状态，因为页面会跳转
            } else {
              // 显示失败弹窗
              alertMessage.textContent = data.error || '登录失败，请检查密码';
              loginAlert.style.display = 'block';
              // 恢复按钮状态
              loginButton.innerHTML = originalButtonContent;
              loginButton.disabled = false;
              // 自动隐藏错误警告
              setTimeout(() => {
                loginAlert.style.display = 'none';
              }, 5000);
            }
          } catch (error) {
            console.error('登录出错:', error);
            // 显示网络或请求错误弹窗
            alertMessage.textContent = '登录请求失败，请稍后重试';
            loginAlert.style.display = 'block';
            // 恢复按钮状态
            loginButton.innerHTML = originalButtonContent;
            loginButton.disabled = false;
             // 自动隐藏错误警告
            setTimeout(() => {
                loginAlert.style.display = 'none';
            }, 5000);
          }
          // 不需要 finally 块恢复按钮，因为成功时会跳转，失败时已在相应代码块恢复
        });
      </script>
    </body>
  </html>
  `;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0', // 强制不缓存登录页
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });
}

/**
 * 提供仪表盘页面的 HTML 响应
 * @returns {Response} HTML 响应对象
 */
function serveDashboardPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>LLM Stream Optimizer - 管理仪表盘</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --primary-color: #4361ee; /* 鲜艳蓝 */
          --primary-hover: #3a55cf; /* 深一点的蓝 */
          --secondary-color: #7209b7; /* 紫色 */
          --accent-color: #4cc9f0; /* 青色 */
          --success-color: #06d6a0; /* 鲜艳绿 */
          --warning-color: #ffd166; /* 黄色 */
          --danger-color: #ef476f; /* 红色 */
          --light-bg: #f8f9fa;
          --dark-bg: #2b2d42; /* 深灰蓝 */
          --card-bg: rgba(255, 255, 255, 0.9); /* 轻微透明白色 */
          --dark-text: #2b2d42;
          --light-text: #8d99ae; /* 灰色 */
          --card-shadow: 0 15px 35px rgba(67, 97, 238, 0.1), 0 5px 15px rgba(0, 0, 0, 0.07); /* 更柔和的阴影 */
          --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
          --footer-height: 70px; /* 页脚高度 */
        }
        html, body {
          height: 100%;
        }
        body {
          background: linear-gradient(135deg, #f5f7fa 0%, #e5e9f2 100%); /* 淡雅背景渐变 */
          font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
          color: var(--dark-text);
          min-height: 100vh;
          margin: 0;
          padding: 0;
          position: relative;
          overflow-x: hidden;
          display: flex;
          flex-direction: column; /* 使页脚能固定在底部 */
        }
        /* 背景装饰图形 (固定位置) */
        body::before, body::after {
          content: '';
          position: fixed; /* 固定位置，不随滚动条滚动 */
          border-radius: 50%;
          background: linear-gradient(135deg, rgba(67, 97, 238, 0.08), rgba(114, 9, 183, 0.08));
          z-index: -1;
          filter: blur(60px); /* 加大模糊 */
        }
        body::before {
          width: 600px;
          height: 600px;
          top: -200px;
          right: -200px;
        }
        body::after {
          width: 500px;
          height: 500px;
          bottom: -150px;
          left: -150px;
          background: linear-gradient(135deg, rgba(76, 201, 240, 0.08), rgba(67, 97, 238, 0.08));
        }
        .main-content {
          flex: 1 0 auto; /* 占据剩余空间 */
          padding-top: 2rem; /* 为粘性页眉留出空间 */
          padding-bottom: calc(var(--footer-height) + 2rem); /* 为页脚留出空间 */
          width: 100%;
        }
        .dashboard-header {
          background-color: rgba(255, 255, 255, 0.85); /* 轻微透明 */
          backdrop-filter: blur(10px); /* 背景模糊 */
          -webkit-backdrop-filter: blur(10px);
          box-shadow: 0 5px 25px rgba(0, 0, 0, 0.05);
          padding: 1rem 0; /* 调整内边距 */
          margin-bottom: 0; /* 移除默认下边距 */
          position: sticky; /* 粘性定位 */
          top: 0;
          z-index: 1020; /* 确保在内容之上 */
          border-bottom: 1px solid rgba(0, 0, 0, 0.05); /* 细微底部分隔线 */
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
          transition: var(--transition);
        }
        .dashboard-brand:hover {
          opacity: 0.8;
        }
        .brand-icon {
          font-size: 1.75rem;
          /* 图标渐变色 */
          background: linear-gradient(120deg, var(--primary-color), var(--secondary-color));
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          margin-right: 0.75rem;
          line-height: 1; /* 确保图标垂直居中 */
        }
        .brand-title {
           font-weight: 700;
           font-size: 1.5rem; /* 调整标题大小 */
           margin-bottom: 0; /* 移除默认下边距 */
           letter-spacing: -0.5px;
        }
        /* 标签页样式 */
        .nav-tabs {
          margin-bottom: 2rem; /* 增加与下方内容的间距 */
          border-bottom: 1px solid #dee2e6; /* 标准Bootstrap下划线 */
          padding: 0 0.5rem; /* 稍微增加左右内边距 */
        }
        .nav-tabs .nav-link {
          border: none;
          font-weight: 500;
          color: var(--light-text);
          padding: 0.75rem 1.25rem;
          margin-bottom: -1px; /* 与下边框重合 */
          border-radius: 8px 8px 0 0; /* 顶部圆角 */
          transition: var(--transition);
          position: relative;
          transform: translateY(0);
        }
        .nav-tabs .nav-link:hover {
          color: var(--primary-color);
          background-color: rgba(67, 97, 238, 0.05);
          transform: translateY(-2px); /* 轻微上移 */
        }
        .nav-tabs .nav-link.active {
          color: var(--primary-color);
          background-color: transparent; /* 激活时背景透明 */
          font-weight: 600;
          border: none; /* 移除Bootstrap默认边框 */
          border-bottom: 3px solid var(--primary-color); /* 使用单色下划线更简洁 */
        }
        /* 移除激活状态下的渐变下划线伪元素 */
        /* .nav-tabs .nav-link.active::after { content: none; } */
        .nav-tabs .nav-link i {
          margin-right: 0.5rem;
          font-size: 1.1em; /* 图标稍微大一点 */
          vertical-align: middle; /* 垂直居中 */
        }
        /* 配置卡片 */
        .config-card {
          background-color: var(--card-bg);
          border-radius: 16px;
          box-shadow: var(--card-shadow);
          padding: 2.5rem; /* 增加内边距 */
          margin-bottom: 2rem;
          transition: var(--transition);
          border: 1px solid rgba(255, 255, 255, 0.3);
          transform: translateY(0);
          position: relative;
          overflow: hidden;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .config-card:hover {
          box-shadow: 0 20px 40px rgba(67, 97, 238, 0.15), 0 8px 20px rgba(0, 0, 0, 0.1);
          transform: translateY(-8px);
        }
        /* 卡片顶部装饰条 */
        .config-card::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 6px;
          background: linear-gradient(90deg, var(--primary-color), var(--accent-color)); /* 使用不同的渐变 */
        }
        .card-title {
          margin-bottom: 2rem; /* 增加标题与内容的间距 */
          color: var(--dark-text);
          font-weight: 700;
          display: flex;
          align-items: center;
          letter-spacing: -0.5px;
          font-size: 1.3rem; /* 调整标题大小 */
        }
        .card-title i {
          margin-right: 0.85rem;
          /* 标题图标渐变色 */
          background: linear-gradient(120deg, var(--primary-color), var(--secondary-color));
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          font-size: 1.7rem; /* 调整图标大小 */
        }
        /* 保存按钮 */
        .btn-save {
          min-width: 120px;
          padding: 0.9rem 1.5rem;
          font-weight: 600;
          letter-spacing: 0.5px;
          border-radius: 12px;
          background: linear-gradient(135deg, var(--primary-color), var(--primary-hover));
          color: #fff;
          border: none;
          transition: var(--transition);
          position: relative;
          overflow: hidden;
          box-shadow: 0 5px 15px rgba(67, 97, 238, 0.2);
          z-index: 1;
        }
        .btn-save:hover {
          background: linear-gradient(135deg, var(--primary-hover), var(--secondary-color));
          transform: translateY(-3px);
          box-shadow: 0 8px 25px rgba(67, 97, 238, 0.3);
        }
        .btn-save:active {
          transform: translateY(-1px);
        }
        /* 按钮闪光效果 (复用登录页样式) */
        .btn-save::after {
          content: '';
          position: absolute;
          top: -50%;
          left: -50%;
          width: 20%;
          height: 200%;
          background: linear-gradient(to right, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.5) 50%, rgba(255, 255, 255, 0) 100%);
          transform: rotate(30deg);
          opacity: 0;
          transition: opacity 0.3s ease;
          z-index: 2;
          pointer-events: none;
        }
        .btn-save:hover::after {
          opacity: 1;
          animation: shine 1.5s ease-out;
        }
        @keyframes shine {
          0% { left: -75%; top: -75%; }
          100% { left: 120%; top: -25%; }
        }
        .btn-save i {
          margin-right: 0.5rem;
        }
        /* 状态徽章 */
        .status-badge {
          font-size: 0.75rem;
          font-weight: 600;
          padding: 0.35rem 0.75rem;
          border-radius: 20px; /* 胶囊形状 */
          animation: fadeIn 0.5s ease forwards; /* 保证动画结束时停留在最终状态 */
          opacity: 0; /* 初始透明 */
          vertical-align: middle; /* 确保与文字对齐 */
          margin-left: 0.5rem; /* 与标题间距 */
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.8); }
          to { opacity: 1; transform: scale(1); }
        }
        .bg-success-custom { /* 自定义成功色，避免覆盖Bootstrap */
          background-color: var(--success-color) !important;
          color: white;
        }
        .bg-secondary-custom { /* 自定义次要色 */
          background-color: var(--light-text) !important;
          color: white;
        }
        /* 表单元素 */
        .form-control {
          border: 1px solid #e9ecef;
          padding: 1rem 1.25rem;
          border-radius: 12px;
          transition: var(--transition);
          font-size: 0.95rem;
          background-color: rgba(249, 250, 251, 0.8);
        }
        .form-control:focus {
          border-color: var(--primary-color);
          box-shadow: 0 0 0 4px rgba(67, 97, 238, 0.15);
          background-color: #fff;
        }
        .form-control:hover {
          border-color: #d0d4d9;
        }
        .form-label {
          font-weight: 600;
          color: var(--dark-text);
          margin-bottom: 0.75rem;
          font-size: 0.95rem;
        }
        .form-text {
          color: var(--light-text);
          font-size: 0.85rem;
          margin-top: 0.5rem;
        }
        /* 提示框 */
        .alert {
          border-radius: 12px;
          padding: 1rem 1.25rem;
          margin-bottom: 2rem;
          border: none;
          display: none; /* 默认隐藏 */
          font-weight: 500;
          animation: slideDown 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55);
          box-shadow: 0 5px 20px rgba(0, 0, 0, 0.05);
        }
        .alert-success { background-color: var(--success-color); color: white; }
        .alert-danger { background-color: var(--danger-color); color: white; }
        .alert-info { background-color: var(--accent-color); color: #fff; }
        .alert-warning { background-color: var(--warning-color); color: var(--dark-text); }

        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-30px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        /* 退出按钮 */
        #logoutBtn {
          padding: 0.6rem 1.1rem; /* 微调尺寸 */
          border-radius: 10px; /* 圆角 */
          border: 1px solid #dee2e6;
          background: transparent;
          color: var(--dark-text);
          font-weight: 500;
          transition: var(--transition);
        }
        #logoutBtn:hover {
          background-color: rgba(67, 97, 238, 0.1); /* 淡蓝色背景 */
          border-color: var(--primary-color);
          color: var(--primary-color);
          transform: translateY(-2px); /* 轻微上移 */
          box-shadow: 0 4px 10px rgba(67, 97, 238, 0.1); /* 添加阴影 */
        }
        #logoutBtn i {
          margin-right: 0.5rem;
        }
        /* API Key 容器和切换按钮 */
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
          transition: var(--transition);
          padding: 0.25rem; /* 增加点击区域 */
          line-height: 1; /* 确保图标垂直居中 */
        }
        .api-key-toggle:hover {
          color: var(--primary-color);
        }
        .api-key-toggle i {
          font-size: 1.2rem; /* 调整图标大小 */
        }
        /* URL 输入框图标 */
        .url-icon {
          position: absolute;
          left: 15px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--light-text);
          pointer-events: none; /* 防止干扰输入 */
          font-size: 1.2rem;
        }
        .has-url-icon {
          padding-left: 3rem; /* 为图标留出空间 */
        }
        /* 分隔线 (多端点配置内部使用) */
        .endpoint-divider {
          height: 1px;
          background: linear-gradient(90deg, rgba(233,236,239,0) 0%, rgba(233,236,239,1) 50%, rgba(233,236,239,0) 100%);
          margin: 1.5rem 0;
        }
        .form-footer {
          display: flex;
          justify-content: flex-end;
          margin-top: 2rem; /* 增加与表单内容的间距 */
          padding-top: 1.5rem; /* 增加顶部内边距 */
          border-top: 1px solid #eee; /* 添加细分隔线 */
        }
        /* 标签页内容切换动画 */
        .tab-pane {
          animation: fadeInPane 0.6s ease forwards;
          opacity: 0;
        }
        @keyframes fadeInPane {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .tab-pane.active {
          opacity: 1; /* 确保激活的tab可见 */
        }
        /* 美化网站页脚 */
        .dashboard-footer {
          text-align: center;
          padding: 1.5rem 0; /* 调整内边距 */
          color: var(--light-text);
          background-color: rgba(255, 255, 255, 0.8); /* 与页眉背景协调 */
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-top: 1px solid rgba(0, 0, 0, 0.05); /* 与页眉协调 */
          flex-shrink: 0; /* 防止页脚缩放 */
          height: var(--footer-height);
          display: flex;
          align-items: center;
          justify-content: center;
          position: fixed; /* 固定在底部 */
          bottom: 0;
          left: 0;
          width: 100%;
          z-index: 1000;
        }
        .dashboard-footer p {
          margin-bottom: 0;
          font-size: 0.9rem;
        }
        .dashboard-footer a {
            color: var(--primary-color);
            text-decoration: none;
            font-weight: 500;
        }
        .dashboard-footer a:hover {
            text-decoration: underline;
        }
        /* 多端点配置卡片样式 */
        .openai-endpoint.card {
           background-color: rgba(248, 249, 250, 0.7); /* 稍微区分背景 */
           border: 1px dashed #dee2e6; /* 虚线边框 */
           box-shadow: none; /* 移除阴影 */
        }
        .openai-endpoint.card:hover {
            transform: none; /* 移除悬停位移 */
            box-shadow: 0 5px 15px rgba(0,0,0,0.05); /* 添加轻微悬停阴影 */
        }
        .openai-endpoint .card-body {
            padding: 1.5rem; /* 调整内边距 */
        }
        .openai-endpoint .card-subtitle {
            font-weight: 600;
            color: var(--dark-text);
        }
         /* 响应式调整 */
        @media (max-width: 992px) {
            .config-card {
                padding: 2rem;
            }
        }
        @media (max-width: 768px) {
          .main-content { padding-top: 1rem; }
          .config-card { padding: 1.5rem; }
          .dashboard-header { padding: 0.75rem 0; }
          .brand-title { font-size: 1.25rem; }
          .nav-tabs .nav-link { padding: 0.6rem 1rem; font-size: 0.9rem; }
          .card-title { font-size: 1.15rem; margin-bottom: 1.5rem; }
          .card-title i { font-size: 1.5rem; }
          .form-footer { margin-top: 1.5rem; padding-top: 1rem; }
        }
         @media (max-width: 576px) {
             .header-container { flex-direction: column; align-items: flex-start; }
             #logoutBtn { margin-top: 0.5rem; align-self: flex-end; }
             .nav-tabs { font-size: 0.85rem; }
             .nav-tabs .nav-link { padding: 0.5rem 0.75rem; }
             .form-control, .form-label, .form-text { font-size: 0.9rem; }
             .btn-save { padding: 0.8rem 1.2rem; font-size: 0.95rem; }
             .config-card { padding: 1rem; }
             .openai-endpoint .card-body { padding: 1rem; }
         }
      </style>
    </head>
    <body>
      <header class="dashboard-header">
        <div class="container">
          <div class="header-container">
            <a href="/admin/dashboard" class="dashboard-brand">
              <div class="brand-icon"><i class="bi bi-braces-asterisk"></i></div>
              <h1 class="brand-title">LLM Stream Optimizer</h1>
            </a>
            <button id="logoutBtn" class="btn">
              <i class="bi bi-box-arrow-right"></i>退出登录
            </button>
          </div>
        </div>
      </header>

      <div class="container main-content">
        <!-- 状态提示框 -->
        <div id="statusAlert" class="alert alert-dismissible fade show mb-4" role="alert">
          <span id="alertMessage"></span>
          <button type="button" class="btn-close" aria-label="Close" onclick="document.getElementById('statusAlert').style.display='none'"></button>
        </div>

        <!-- 导航标签 -->
        <ul class="nav nav-tabs" id="configTabs" role="tablist">
          <li class="nav-item" role="presentation">
            <button class="nav-link active" id="openai-tab" data-bs-toggle="tab" data-bs-target="#openai" type="button" role="tab" aria-controls="openai" aria-selected="true">
              <i class="bi bi-chat-square-text"></i>OpenAI
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="anthropic-tab" data-bs-toggle="tab" data-bs-target="#anthropic" type="button" role="tab" aria-controls="anthropic" aria-selected="false">
              <i class="bi bi-stars"></i>Anthropic
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="gemini-tab" data-bs-toggle="tab" data-bs-target="#gemini" type="button" role="tab" aria-controls="gemini" aria-selected="false">
              <i class="bi bi-gem"></i>Gemini
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="general-tab" data-bs-toggle="tab" data-bs-target="#general" type="button" role="tab" aria-controls="general" aria-selected="false">
              <i class="bi bi-sliders"></i>通用与优化 <!-- 改用更形象的图标 -->
            </button>
          </li>
        </ul>

        <!-- 标签页内容 -->
        <div class="tab-content" id="configTabsContent">
          <!-- OpenAI配置 -->
          <div class="tab-pane fade show active" id="openai" role="tabpanel" aria-labelledby="openai-tab">
            <div class="config-card">
              <h5 class="card-title">
                <i class="bi bi-chat-square-text"></i>
                OpenAI 格式 API 配置
                <span id="openaiStatus" class="badge status-badge bg-secondary-custom">未启用</span>
              </h5>
              <form id="openaiForm">
                <div class="mb-4 alert alert-info d-flex align-items-center">
                    <i class="bi bi-info-circle-fill flex-shrink-0 me-2" style="font-size: 1.2rem;"></i>
                    <div>
                        本配置已改为完全使用下方的多端点配置模式。请添加并管理您的 OpenAI 格式 API 端点。
                    </div>
                </div>

                <!-- 多端点配置 -->
                <div class="mt-4 mb-4">
                  <h6 class="mb-3 fw-bold">
                    <i class="bi bi-diagram-3-fill me-2 text-primary"></i>
                    API 端点管理
                    <button type="button" class="btn btn-sm btn-outline-primary ms-2 rounded-pill px-3" id="addOpenAIEndpoint">
                      <i class="bi bi-plus-circle me-1"></i> 添加端点
                    </button>
                  </h6>
                  <div class="form-text mb-3">您可以配置多个 OpenAI 格式的 API 端点。如果设置了模型名称，请求将自动路由到支持该模型的端点。</div>
                  <div id="openaiEndpointsContainer">
                    <!-- 端点列表将通过JS动态生成 -->
                  </div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存 OpenAI 配置
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
                Anthropic 格式 API 配置
                <span id="anthropicStatus" class="badge status-badge bg-secondary-custom">未启用</span>
              </h5>
              <form id="anthropicForm">
                <div class="mb-4">
                  <label for="anthropicUpstreamUrl" class="form-label">API 端点 URL</label>
                  <div class="position-relative">
                    <i class="bi bi-link-45deg url-icon"></i>
                    <input type="url" class="form-control has-url-icon" id="anthropicUpstreamUrl" placeholder="例如: https://api.anthropic.com">
                  </div>
                  <div class="form-text">请输入 Anthropic 格式 API 的基础 URL。</div>
                </div>
                <div class="mb-4">
                  <label for="anthropicApiKey" class="form-label">API 密钥</label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control" id="anthropicApiKey" placeholder="sk-ant-..." autocomplete="off">
                    <button type="button" class="api-key-toggle" data-target="anthropicApiKey" tabindex="-1">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">支持设置多个 API 密钥，请使用英文逗号 (,) 分隔，系统将进行负载均衡。</div>
                </div>
                <div class="mb-4 form-check form-switch ps-0"> <!-- 调整Switch对齐 -->
                  <div class="d-flex align-items-center">
                    <input class="form-check-input ms-0 me-2" type="checkbox" id="anthropicUseNativeFetch" style="font-size: 1.2em; margin-top: 0;">
                    <label class="form-check-label" for="anthropicUseNativeFetch">使用原生 Fetch</label>
                  </div>
                  <div class="form-text mt-1">启用此选项可增强安全性，但可能无法访问部署在 Cloudflare CDN 后的 API 端点。</div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存 Anthropic 配置
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
                Gemini 格式 API 配置
                <span id="geminiStatus" class="badge status-badge bg-secondary-custom">未启用</span>
              </h5>
              <form id="geminiForm">
                <div class="mb-4">
                  <label for="geminiUpstreamUrl" class="form-label">API 端点 URL</label>
                  <div class="position-relative">
                    <i class="bi bi-link-45deg url-icon"></i>
                    <input type="url" class="form-control has-url-icon" id="geminiUpstreamUrl" placeholder="例如: https://generativelanguage.googleapis.com">
                  </div>
                  <div class="form-text">请输入 Gemini 格式 API 的基础 URL。</div>
                </div>
                <div class="mb-4">
                  <label for="geminiApiKey" class="form-label">API 密钥</label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control" id="geminiApiKey" placeholder="AIzaSy..." autocomplete="off">
                    <button type="button" class="api-key-toggle" data-target="geminiApiKey" tabindex="-1">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">支持设置多个 API 密钥，请使用英文逗号 (,) 分隔，系统将进行负载均衡。</div>
                </div>
                 <div class="mb-4 form-check form-switch ps-0"> <!-- 调整Switch对齐 -->
                  <div class="d-flex align-items-center">
                    <input class="form-check-input ms-0 me-2" type="checkbox" id="geminiUseNativeFetch" style="font-size: 1.2em; margin-top: 0;">
                    <label class="form-check-label" for="geminiUseNativeFetch">使用原生 Fetch (推荐)</label>
                  </div>
                  <div class="form-text mt-1">强烈建议开启。启用可增强安全性并可解决国内访问问题。</div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存 Gemini 配置
                  </button>
                </div>
              </form>
            </div>
          </div>

          <!-- 通用设置 -->
          <div class="tab-pane fade" id="general" role="tabpanel" aria-labelledby="general-tab">
            <!-- 代理密钥设置 -->
            <div class="config-card mb-4">
              <h5 class="card-title"><i class="bi bi-shield-lock-fill"></i>代理访问控制</h5>
              <form id="proxyForm">
                <div class="mb-3"> <!-- 减少与其他部分的间距 -->
                  <label for="proxyApiKey" class="form-label">代理 API 密钥</label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control" id="proxyApiKey" placeholder="留空表示无需密钥访问" autocomplete="new-password"> <!-- 添加autocomplete提示 -->
                    <button type="button" class="api-key-toggle" data-target="proxyApiKey" tabindex="-1">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">客户端访问此代理服务时需要提供的 API 密钥。这也是您登录管理界面的密码。如果留空，则任何知道此 Worker URL 的人都可以访问。</div>
                </div>
                <div class="form-footer pt-3 mt-3"> <!-- 调整边距 -->
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-key-fill"></i>更新访问密钥
                  </button>
                </div>
              </form>
            </div>

            <!-- 流式输出优化设置 -->
            <div class="config-card">
              <h5 class="card-title"><i class="bi bi-activity"></i>流式输出优化</h5>
              <form id="streamForm">
                 <div class="alert alert-info d-flex align-items-center mb-4">
                    <i class="bi bi-lightbulb-fill flex-shrink-0 me-2" style="font-size: 1.2rem;"></i>
                    <div>
                        调整这些参数可以模拟更自然的打字效果，或在需要时加速输出。请根据您的需求和模型响应速度进行微调。
                    </div>
                </div>
                <div class="row g-3"> <!-- 使用g-3控制栅格间距 -->
                  <div class="col-md-6">
                    <label for="minDelay" class="form-label">最小延迟 (毫秒)</label>
                    <input type="number" class="form-control" id="minDelay" min="0" max="100" step="1">
                    <div class="form-text">两次字符输出之间的最小间隔时间。</div>
                  </div>
                  <div class="col-md-6">
                    <label for="maxDelay" class="form-label">最大延迟 (毫秒)</label>
                    <input type="number" class="form-control" id="maxDelay" min="1" max="500" step="1">
                    <div class="form-text">两次字符输出之间的最大间隔时间。</div>
                  </div>
                  <div class="col-md-6">
                    <label for="adaptiveDelayFactor" class="form-label">自适应延迟因子</label>
                    <input type="number" class="form-control" id="adaptiveDelayFactor" min="0" max="2" step="0.1">
                    <div class="form-text">影响延迟如何根据模型响应速度自适应调整。0 表示不调整。</div>
                  </div>
                  <div class="col-md-6">
                    <label for="chunkBufferSize" class="form-label">块缓冲区大小</label>
                    <input type="number" class="form-control" id="chunkBufferSize" min="1" max="50" step="1">
                    <div class="form-text">用于计算平均响应速度的块数量。</div>
                  </div>
                   <div class="col-md-6">
                    <label for="minContentLengthForFastOutput" class="form-label">快速输出阈值 (字符)</label>
                    <input type="number" class="form-control" id="minContentLengthForFastOutput" min="100" max="10000" step="100">
                    <div class="form-text">当预期内容长度超过此值时，可能启用更快的输出模式。</div>
                  </div>
                  <div class="col-md-6">
                    <label for="fastOutputDelay" class="form-label">快速输出延迟 (毫秒)</label>
                    <input type="number" class="form-control" id="fastOutputDelay" min="0" max="20" step="1">
                    <div class="form-text">在快速输出模式下的固定间隔时间。</div>
                  </div>
                  <div class="col-md-6">
                    <label for="finalLowDelay" class="form-label">结束阶段延迟 (毫秒)</label>
                    <input type="number" class="form-control" id="finalLowDelay" min="0" max="20" step="1">
                    <div class="form-text">模型响应接近结束时的输出间隔，以尽快完成。</div>
                  </div>
                   <div class="col-md-6">
                    <label for="disableOptimizationModels" class="form-label">禁用优化的模型</label>
                    <input type="text" class="form-control" id="disableOptimizationModels" placeholder="例如: gpt-4o, claude-3-opus">
                    <div class="form-text">指定模型名称（英文逗号分隔），这些模型将不应用流式优化，直接透传。</div>
                  </div>
                </div>
                <div class="form-footer">
                  <button type="submit" class="btn btn-primary btn-save">
                    <i class="bi bi-check-circle"></i>保存优化设置
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div> <!-- end tab-content -->
      </div> <!-- end container -->

      <!-- 页脚 -->
      <footer class="dashboard-footer">
        <div class="container">
          <p>LLM Stream Optimizer &copy; 2025 by <a href="https://github.com/GeorgeXie2333/LLM-Stream-Optimizer" target="_blank" rel="noopener noreferrer">GeorgeXie2333</a></p>
        </div>
      </footer>

      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js"></script>
      <script>
        // 全局变量存储端点数据，避免重复查询DOM
        let currentOpenAIEndpoints = [];

        // 显示提示消息 (优化)
        function showAlert(type, message, duration = 5000) {
          const alertElement = document.getElementById('statusAlert');
          const messageElement = document.getElementById('alertMessage');

          // Map type to Bootstrap alert class
          const alertClassMap = {
            success: 'alert-success',
            danger: 'alert-danger',
            warning: 'alert-warning',
            info: 'alert-info'
          };
          const alertClass = alertClassMap[type] || 'alert-secondary'; // Default to secondary if type is unknown

          alertElement.className = \`alert \${alertClass} alert-dismissible fade show mb-4\`; // Use template literal
          messageElement.innerHTML = message; // Use innerHTML to allow potential basic formatting like icons
          alertElement.style.display = 'block';
          alertElement.style.opacity = 1; // Ensure opacity is set for fade out

          // Clear existing timer if any
          if (alertElement.timerId) {
            clearTimeout(alertElement.timerId);
          }

          // Auto-hide after duration
          if (duration > 0) {
             alertElement.timerId = setTimeout(() => {
                // Fade out effect
                alertElement.style.opacity = 0;
                // Wait for fade out transition before hiding
                setTimeout(() => {
                   if (alertElement.style.opacity === '0') { // Check if it wasn't shown again
                     alertElement.style.display = 'none';
                   }
                }, 300); // Match transition duration if needed
            }, duration);
          }
        }

        // 更新状态徽章 (优化)
        function updateStatusBadge(elementId, isEnabled) {
            const badge = document.getElementById(elementId);
            if (badge) {
                badge.textContent = isEnabled ? '已启用' : '未启用';
                badge.classList.toggle('bg-success-custom', isEnabled);
                badge.classList.toggle('bg-secondary-custom', !isEnabled);
                badge.style.opacity = 0; // Reset opacity for animation
                requestAnimationFrame(() => { // Force reflow for animation
                  badge.style.opacity = 1;
                });
            }
        }

        // 密钥显示/隐藏切换功能 (优化)
        function setupApiKeyToggle() {
            document.querySelectorAll('.api-key-toggle').forEach(button => {
                // Remove existing listener to prevent duplicates if called multiple times
                button.removeEventListener('click', toggleApiKeyVisibility);
                // Add listener
                button.addEventListener('click', toggleApiKeyVisibility);
            });
        }
        function toggleApiKeyVisibility() {
            const targetId = this.getAttribute('data-target');
            // Find input relative to the button's parent container for better scoping in dynamic forms
            const inputField = this.closest('.api-key-wrapper').querySelector(\`input[id="\${targetId}"]\`) || document.getElementById(targetId);
            const icon = this.querySelector('i');
            if (inputField && icon) {
                if (inputField.type === 'password') {
                inputField.type = 'text';
                icon.classList.remove('bi-eye');
                icon.classList.add('bi-eye-slash');
                } else {
                inputField.type = 'password';
                icon.classList.remove('bi-eye-slash');
                icon.classList.add('bi-eye');
                }
            }
        }

        // 加载配置
        async function loadConfig() {
          try {
            const response = await fetch('/admin/api/config');
            if (!response.ok) {
              if (response.status === 401) {
                window.location.href = '/admin'; // 未授权，跳转登录
                return;
              }
              throw new Error(\`获取配置失败: \${response.status} \${response.statusText}\`);
            }
            const data = await response.json();
            if (data.success && data.config) {
              const config = data.config;

              // OpenAI配置
              currentOpenAIEndpoints = config.openaiEndpoints || [];
              loadOpenAIEndpointsUI(currentOpenAIEndpoints);
              updateStatusBadge('openaiStatus', currentOpenAIEndpoints.length > 0);

              // Anthropic配置
              document.getElementById('anthropicUpstreamUrl').value = config.anthropicUpstreamUrl || '';
              document.getElementById('anthropicApiKey').value = config.anthropicApiKey || '';
              document.getElementById('anthropicUseNativeFetch').checked = config.anthropicUseNativeFetch === true;
              updateStatusBadge('anthropicStatus', config.anthropicEnabled);

              // Gemini配置
              document.getElementById('geminiUpstreamUrl').value = config.geminiUpstreamUrl || '';
              document.getElementById('geminiApiKey').value = config.geminiApiKey || '';
              document.getElementById('geminiUseNativeFetch').checked = config.geminiUseNativeFetch === true;
              updateStatusBadge('geminiStatus', config.geminiEnabled);

              // 代理设置
              document.getElementById('proxyApiKey').value = config.proxyApiKey || '';

              // 流式输出设置 (Provide defaults if missing)
              document.getElementById('minDelay').value = config.minDelay ?? 5;
              document.getElementById('maxDelay').value = config.maxDelay ?? 40;
              document.getElementById('adaptiveDelayFactor').value = config.adaptiveDelayFactor ?? 0.8;
              document.getElementById('chunkBufferSize').value = config.chunkBufferSize ?? 8;
              document.getElementById('minContentLengthForFastOutput').value = config.minContentLengthForFastOutput ?? 1000; // Default value corrected
              document.getElementById('fastOutputDelay').value = config.fastOutputDelay ?? 1;
              document.getElementById('finalLowDelay').value = config.finalLowDelay ?? 1;
              document.getElementById('disableOptimizationModels').value = (config.disableOptimizationModels || []).join(',');

              // Setup toggles after loading potential new fields
              setupApiKeyToggle();

            } else {
              showAlert('danger', data.message || '加载配置数据格式错误');
            }
          } catch (error) {
            showAlert('danger', \`加载配置请求失败: \${error.message}\`);
            if (error.message.includes('401')) { // Redirect on 401 errors during load
                 setTimeout(() => window.location.href = '/admin', 3000);
            }
          }
        }

        // 保存配置 (通用函数)
        async function saveConfig(formData, buttonElement) {
          const originalButtonText = buttonElement.innerHTML;
          buttonElement.innerHTML = \`<i class="bi bi-hourglass-split me-2"></i> 保存中...\`;
          buttonElement.disabled = true;

          try {
            const response = await fetch('/admin/api/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(formData)
            });
            const data = await response.json();
            if (data.success) {
              showAlert('success', data.message || '配置保存成功！');
              // 重新加载配置以更新状态等
              await loadConfig();
            } else {
              showAlert('danger', data.message || '配置保存失败');
            }
          } catch (error) {
            showAlert('danger', \`保存配置请求失败: \${error.message}\`);
          } finally {
             // Add a small delay before restoring button to give feedback time
             setTimeout(() => {
                buttonElement.innerHTML = originalButtonText;
                buttonElement.disabled = false;
             }, 500);
          }
        }

        // 表单提交处理
        document.getElementById('openaiForm').addEventListener('submit', function(e) {
          e.preventDefault();
          const formData = {
            openaiEndpoints: getOpenAIEndpointsConfigFromUI()
          };
          saveConfig(formData, this.querySelector('.btn-save'));
        });

        document.getElementById('anthropicForm').addEventListener('submit', function(e) {
          e.preventDefault();
          const formData = {
            anthropicUpstreamUrl: document.getElementById('anthropicUpstreamUrl').value.trim(),
            anthropicApiKey: document.getElementById('anthropicApiKey').value.trim(),
            anthropicUseNativeFetch: document.getElementById('anthropicUseNativeFetch').checked
          };
          saveConfig(formData, this.querySelector('.btn-save'));
        });

        document.getElementById('geminiForm').addEventListener('submit', function(e) {
          e.preventDefault();
          const formData = {
            geminiUpstreamUrl: document.getElementById('geminiUpstreamUrl').value.trim(),
            geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
            geminiUseNativeFetch: document.getElementById('geminiUseNativeFetch').checked
          };
          saveConfig(formData, this.querySelector('.btn-save'));
        });

        document.getElementById('proxyForm').addEventListener('submit', function(e) {
          e.preventDefault();
          const formData = {
            proxyApiKey: document.getElementById('proxyApiKey').value.trim() // Trim whitespace
          };
          saveConfig(formData, this.querySelector('.btn-save'));
        });

        document.getElementById('streamForm').addEventListener('submit', function(e) {
          e.preventDefault();
          const formData = {
            minDelay: parseInt(document.getElementById('minDelay').value) || 0,
            maxDelay: parseInt(document.getElementById('maxDelay').value) || 1,
            adaptiveDelayFactor: parseFloat(document.getElementById('adaptiveDelayFactor').value) || 0,
            chunkBufferSize: parseInt(document.getElementById('chunkBufferSize').value) || 1,
            minContentLengthForFastOutput: parseInt(document.getElementById('minContentLengthForFastOutput').value) || 100,
            fastOutputDelay: parseInt(document.getElementById('fastOutputDelay').value) || 0,
            finalLowDelay: parseInt(document.getElementById('finalLowDelay').value) || 0,
            disableOptimizationModels: document.getElementById('disableOptimizationModels').value
              .split(',')
              .map(model => model.trim())
              .filter(model => model) // 过滤空字符串
          };
          // Basic validation for min/max delay
          if (formData.minDelay > formData.maxDelay) {
              showAlert('warning', '最小延迟不能大于最大延迟。');
              return; // Prevent saving
          }
          saveConfig(formData, this.querySelector('.btn-save'));
        });

         // 退出登录
        document.getElementById('logoutBtn').addEventListener('click', async function() {
          this.disabled = true; // Disable button immediately
          this.innerHTML = '<i class="bi bi-hourglass-split"></i> 退出中...';

          try {
            // Server-side logout
            const response = await fetch('/admin/api/logout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });

            // Client-side cleanup (best effort)
            document.cookie = 'admin_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; SameSite=Lax';
            document.cookie = 'admin_session=; Path=/admin; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; SameSite=Lax';
             // Consider clearing storage if needed, but usually cookie removal is enough
             // localStorage.clear();
             // sessionStorage.clear();

            if (response.ok) {
              // Redirect after a short delay to show feedback
              setTimeout(() => window.location.href = '/admin', 500);
            } else {
              showAlert('danger', \`退出登录失败: \${response.statusText}\`);
              this.disabled = false; // Re-enable button on failure
              this.innerHTML = '<i class="bi bi-box-arrow-right"></i> 退出登录';
            }
          } catch (error) {
            showAlert('danger', \`退出登录请求出错: \${error.message}\`);
            this.disabled = false; // Re-enable button on error
            this.innerHTML = '<i class="bi bi-box-arrow-right"></i> 退出登录';
          }
        });

        // --- OpenAI 多端点 UI ---

        function generateUUID() {
          return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
            (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
          );
        }

        // 从UI读取OpenAI端点配置
        function getOpenAIEndpointsConfigFromUI() {
            const endpoints = [];
            const container = document.getElementById('openaiEndpointsContainer');
            container.querySelectorAll('.openai-endpoint').forEach(element => {
                const id = element.dataset.id;
                const nameInput = element.querySelector(\`.endpoint-name-\${id}\`);
                const urlInput = element.querySelector(\`.endpoint-url-\${id}\`);
                const apiKeyInput = element.querySelector(\`.endpoint-apikey-\${id}\`);
                const modelsInput = element.querySelector(\`.endpoint-models-\${id}\`);
                const nativeFetchInput = element.querySelector(\`.endpoint-native-fetch-\${id}\`);

                const url = urlInput?.value.trim();
                // 基本校验：URL和API Key不能为空
                if (url) {
                    endpoints.push({
                        id: id, // 保留ID用于可能的更新操作
                        name: nameInput?.value.trim() || '',
                        url: url,
                        apiKey: apiKeyInput?.value.trim() || '', // 允许暂时为空，但保存时应提示
                        models: modelsInput?.value.split(',').map(m => m.trim()).filter(m => m) || [],
                        useNativeFetch: nativeFetchInput?.checked || false
                    });
                } else if (apiKeyInput?.value.trim() || nameInput?.value.trim() || modelsInput?.value.trim()) {
                   // 如果URL为空但其他字段有值，可能需要提示用户
                   showAlert('warning', \`端点 "\${nameInput?.value.trim() || '未命名'}" 的URL不能为空，该端点未保存。\`, 7000);
                }
            });
            return endpoints;
        }


        // 加载OpenAI多端点UI
        function loadOpenAIEndpointsUI(endpoints) {
            const container = document.getElementById('openaiEndpointsContainer');
            container.innerHTML = ''; // 清空现有UI
            if (!endpoints || endpoints.length === 0) {
                // 可以选择添加一个空表单，或显示提示信息
                container.innerHTML = '<p class="text-muted text-center my-3">尚未配置 OpenAI 端点。点击上方 "添加端点" 开始配置。</p>';
            } else {
                endpoints.forEach(endpoint => addOpenAIEndpointFormUI(endpoint, false)); // 初始加载时不触发保存
            }
             // 确保所有 API Key 切换按钮都已初始化
            setupApiKeyToggle();
        }

        // 添加单个OpenAI端点表单到UI
        function addOpenAIEndpointFormUI(endpointData = null, isNew = true) {
          const container = document.getElementById('openaiEndpointsContainer');
          // 移除初始的提示信息（如果存在）
          const placeholder = container.querySelector('p.text-muted');
          if(placeholder) placeholder.remove();

          const id = endpointData?.id || generateUUID();
          const endpoint = endpointData || { id: id, name: '', url: '', apiKey: '', models: [], useNativeFetch: false }; // 默认空数据

          const div = document.createElement('div');
          div.className = 'openai-endpoint card mb-3';
          div.dataset.id = id;
          // 使用模板字符串构建HTML，更易读
          div.innerHTML = \`
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-3">
                <h6 class="card-subtitle text-muted">端点 ID: \${id.substring(0,8)}...</h6>
                <button type="button" class="btn btn-sm btn-outline-danger remove-endpoint" data-id="\${id}" title="删除此端点">
                  <i class="bi bi-trash"></i> 删除
                </button>
              </div>
              <div class="row g-3">
                <div class="col-md-6">
                  <label class="form-label">端点名称 (可选)</label>
                  <input type="text" class="form-control endpoint-name-\${id}" placeholder="例: OpenAI 官方" value="\${endpoint.name || ''}">
                </div>
                <div class="col-md-6">
                  <label class="form-label">API 端点 URL <span class="text-danger">*</span></label>
                  <input type="url" class="form-control endpoint-url-\${id}" placeholder="https://api.openai.com/v1" value="\${endpoint.url || ''}" required>
                  <div class="form-text">必须填写基础路径 (例如 /v1)。</div>
                </div>
                <div class="col-md-6">
                  <label class="form-label">API 密钥 <span class="text-danger">*</span></label>
                  <div class="api-key-wrapper">
                    <input type="password" class="form-control endpoint-apikey-\${id}" id="endpoint-apikey-\${id}" placeholder="sk-..." value="\${endpoint.apiKey || ''}" autocomplete="off" required>
                    <button type="button" class="api-key-toggle" data-target="endpoint-apikey-\${id}" tabindex="-1">
                      <i class="bi bi-eye"></i>
                    </button>
                  </div>
                  <div class="form-text">支持设置多个 API 密钥，请使用英文逗号 (,) 分隔，系统将进行负载均衡。</div>
                </div>
                <div class="col-md-6">
                  <label class="form-label">支持的模型 (可选)</label>
                  <input type="text" class="form-control endpoint-models-\${id}" placeholder="gpt-4, gpt-3.5-turbo" value="\${(endpoint.models || []).join(', ')}">
                  <div class="form-text">英文逗号分隔，留空表示支持所有模型。若使用多个API端点则必须设置。</div>
                </div>
                <div class="col-md-6">
                  <div class="form-check form-switch mt-md-4 pt-md-2"> <!-- 微调对齐 -->
                    <input class="form-check-input endpoint-native-fetch-\${id}" type="checkbox" id="useNativeFetch-\${id}" \${endpoint.useNativeFetch ? 'checked' : ''}>
                    <label class="form-check-label" for="useNativeFetch-\${id}">使用原生 Fetch</label>
                    <div class="form-text">启用此选项可增强安全性，但可能无法访问部署在 Cloudflare CDN 后的 API 端点。</div>
                  </div>
                </div>
              </div>
            </div>
          \`;

          container.appendChild(div);

          // 添加删除事件监听器
          div.querySelector('.remove-endpoint').addEventListener('click', function() {
              div.remove(); // 直接移除DOM元素
               // 如果移除后容器为空，可以再次显示提示信息
                if (container.children.length === 0) {
                   container.innerHTML = '<p class="text-muted text-center my-3">尚未配置 OpenAI 端点。点击上方 "添加端点" 开始配置。</p>';
                }
              // 注意：删除后需要用户手动点击保存按钮才能生效
              showAlert('info', '端点已从界面移除，请点击保存按钮以确认更改。', 5000);
          });

          // 为新添加的元素设置API Key切换
          setupApiKeyToggle();

           // 如果是新添加的，滚动到视图并高亮显示
            if (isNew) {
                div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                // 添加短暂高亮效果
                div.style.transition = 'background-color 0.5s ease-out';
                div.style.backgroundColor = 'rgba(67, 97, 238, 0.1)';
                setTimeout(() => {
                    div.style.backgroundColor = ''; // 恢复背景色
                }, 1500);
            }
        }

        // “添加端点”按钮事件
        document.getElementById('addOpenAIEndpoint').addEventListener('click', function() {
          addOpenAIEndpointFormUI(null, true); // 添加一个空的新表单
        });

        // 页面加载时执行初始化
        window.addEventListener('load', async () => {
            await loadConfig(); // 加载配置
            setupApiKeyToggle(); // 初始化所有API Key切换按钮
            // 可以添加其他初始化逻辑
        });

      </script>
    </body>
  </html>
  `;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // 仪表盘页面通常需要验证，所以不缓存或限制缓存
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
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
    // 解析请求URL
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    
    // 检查是否为模型列表请求
    const isModelsReq = path.includes('/models');
    
    // 验证代理API密钥 (对于模型列表请求，validateProxyApiKey已经放宽了验证)
    if (!validateProxyApiKey(request, config)) {
      console.log("API密钥验证失败");
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
    
    // 检查是否为模型列表请求,如果是则特殊处理
    if (isModelsReq) {
      console.log("处理模型列表请求");
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
      let upstreamUrlInfo = extractUpstreamUrl(request, config);
      let outgoingApiKey = extractOutgoingApiKey(request, config);
      
      // 完全重写模型验证逻辑
      if (requestBody.model) {
        const modelName = requestBody.model.toString().toLowerCase().trim();
        console.log(`模型请求: ${modelName}, 选择的端点: ${upstreamUrlInfo.url}`);
        
        // 不进行模型验证的情况:
        // 1. 端点没有设置restrictedModels
        // 2. 端点的restrictedModels为空数组
        if (!upstreamUrlInfo.restrictedModels || upstreamUrlInfo.restrictedModels.length === 0) {
          console.log(`选择的端点没有设置限制模型列表，允许所有模型`);
        } 
        // 进行模型验证
        else {
          console.log(`正在验证模型 ${modelName} 是否在允许列表中:`, upstreamUrlInfo.restrictedModels);
          
          // 首先检查完全匹配
          let exactMatch = upstreamUrlInfo.restrictedModels.some(m => 
            m.toLowerCase().trim() === modelName
          );
          
          if (exactMatch) {
            console.log(`模型 ${modelName} 完全匹配成功，允许请求`);
          } else {
            // 然后检查部分匹配
            const partialMatch = upstreamUrlInfo.restrictedModels.some(m => {
              const lowerM = m.toLowerCase().trim();
              return modelName.includes(lowerM) || lowerM.includes(modelName);
            });
            
            if (partialMatch) {
              console.log(`模型 ${modelName} 部分匹配成功，允许请求`);
            } else {
              console.log(`模型 ${modelName} 匹配失败，拒绝请求`);
              
              // 尝试在其他端点中查找支持该模型的端点
              console.log(`正在检查其他端点是否支持模型 ${modelName}...`);
              
              // 查找可能支持该模型的其他端点
              const otherEndpoints = config.openaiEndpoints.filter(endpoint => 
                endpoint.url && 
                endpoint.url !== upstreamUrlInfo.url && 
                endpoint.models && 
                endpoint.models.length > 0
              );
              
              const supportingEndpoints = [];
              const supportingEndpointDetails = [];
              for (const endpoint of otherEndpoints) {
                const supported = endpoint.models.some(m => {
                  const lowerM = m.toLowerCase().trim();
                  return modelName === lowerM || 
                        modelName.includes(lowerM) || 
                        lowerM.includes(modelName);
                });
                
                if (supported) {
                  supportingEndpoints.push(endpoint.name);
                  supportingEndpointDetails.push(endpoint);
                }
              }
              
              // 如果找到支持该模型的其他端点，自动重定向到第一个支持的端点
              if (supportingEndpointDetails.length > 0) {
                console.log(`找到支持模型 ${modelName} 的其他端点，自动重定向到: ${supportingEndpointDetails[0].name}`);
                
                // 更新上游URL信息，使用新端点
                upstreamUrlInfo = { 
                  url: supportingEndpointDetails[0].url, 
                  useNativeFetch: supportingEndpointDetails[0].useNativeFetch !== undefined ? supportingEndpointDetails[0].useNativeFetch : true,
                  restrictedModels: supportingEndpointDetails[0].models
                };
                
                // 可能还需要更新API密钥
                if (supportingEndpointDetails[0].apiKey) {
                  const keys = supportingEndpointDetails[0].apiKey.split(',').map(k => k.trim()).filter(Boolean);
                  if (keys.length > 0) {
                    outgoingApiKey = keys[Math.floor(Math.random() * keys.length)];
                  }
                }
                
                console.log(`已自动重定向到端点 ${supportingEndpointDetails[0].name}`);
              } else {
                // 如果没有找到支持的端点，返回错误
                let errorMessage = `模型 ${requestBody.model} 不在此端点的支持列表中`;
                if (supportingEndpoints.length > 0) {
                  errorMessage += `。该模型可能在以下端点支持: ${supportingEndpoints.join(', ')}`;
                }
                
                return new Response(JSON.stringify({
                  error: {
                    message: errorMessage,
                    type: "invalid_request_error",
                    param: "model",
                    code: 400
                  }
                }), {
                  status: 400,
                  headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                  }
                });
              }
            }
          }
        }
      }
      
      upstreamRequest = createUpstreamRequest(
        `${upstreamUrlInfo.url.endsWith('/') ? upstreamUrlInfo.url.slice(0, -1) : upstreamUrlInfo.url}/chat/completions`, 
        request, 
        requestBody, 
        outgoingApiKey
      );
      
      // 添加原生Fetch标志
      upstreamRequest.useNativeFetch = upstreamUrlInfo.useNativeFetch;
    }
    
    // 根据配置决定是否使用原生Fetch
    let upstreamResponse;
    
    console.log(`使用${upstreamRequest.useNativeFetch && !upstreamRequest.forceStandardFetch ? '原生' : '标准'}Fetch发送请求到: ${upstreamRequest.url}`);
    
    if (upstreamRequest.useNativeFetch && !upstreamRequest.forceStandardFetch) {
      // 使用nativeFetch发送请求到上游API
      upstreamResponse = await nativeFetch(upstreamRequest, upstreamRequest.url);
    } else {
      // 使用标准fetch
      // 构建标准fetch请求
      const fetchOptions = {
        method: upstreamRequest.method || 'POST',
        headers: upstreamRequest.headers,
        body: upstreamRequest.body
      };
      
      try {
        upstreamResponse = await fetch(upstreamRequest.url, fetchOptions);
      } catch (fetchError) {
        console.error(`标准Fetch失败，尝试回退到原生Fetch: ${fetchError.message}`);
        // 如果标准fetch失败，回退到nativeFetch
        upstreamResponse = await nativeFetch(upstreamRequest, upstreamRequest.url);
      }
    }
    
    // 记录上游API的响应状态
    console.log(`上游API响应: status=${upstreamResponse.status}, 流请求=${isStreamRequest}`);
    
    // 如果不是流式请求或响应不成功,直接返回上游响应
    if (!isStreamRequest || !upstreamResponse.ok) {
      // 如果不是OpenAI API,需要转换响应格式
      if (apiType !== 'openai' && upstreamResponse.ok) {
        console.log(`转换非OpenAI格式(${apiType})响应为OpenAI格式`);
        return await convertToOpenAIResponse(upstreamResponse, apiType, config);
      }
      
      // 如果响应失败，记录错误信息
      if (!upstreamResponse.ok) {
        try {
          const errorText = await upstreamResponse.clone().text();
          console.error(`上游API错误: status=${upstreamResponse.status}, body=${errorText.substring(0, 200)}`);
        } catch (e) {
          console.error(`无法读取上游API错误详情: ${e.message}`);
        }
      }
      
      return addCorsHeaders(upstreamResponse);
    }
    
    // 处理流式响应
    console.log(`开始处理${apiType}流式响应`);
    
    // 如果是流式响应，在此处将我们自定义的模型名称头部转发
    // 创建新的响应，保留原始响应的主体，但添加自定义头部
    if (requestBody && requestBody.model) {
      // 克隆响应头部
      const newHeaders = new Headers(upstreamResponse.headers);
      // 添加模型名称头部
      newHeaders.set('x-model-name', requestBody.model.toString());
      
      // 创建新的响应
      const enhancedResponse = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: newHeaders
      });
      
      return handleStreamingResponse(enhancedResponse, apiType, config);
    }
    
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
  
  // 首先检查Anthropic API
  if (config.anthropicEnabled) {
    // 只有在Anthropic API启用时才检查匹配Anthropic的前缀
    for (const [prefix, apiType] of Object.entries(MODEL_PREFIX_MAP)) {
      if (apiType === 'anthropic' && modelName.startsWith(prefix)) {
        return 'anthropic';
      }
    }
  }
  
  // 然后检查Gemini API
  if (config.geminiEnabled) {
    // 只有在Gemini API启用时才检查匹配Gemini的前缀
    for (const [prefix, apiType] of Object.entries(MODEL_PREFIX_MAP)) {
      if (apiType === 'gemini' && modelName.startsWith(prefix)) {
        return 'gemini';
      }
    }
  }
  
  // 如果没有匹配到任何已启用的API，或者对应的API未启用，默认返回openai
  return 'openai';
}

// 统一处理模型列表请求
async function handleModelsRequest(request, config) {
  try {
    // 添加调试日志，记录请求和配置状态
    console.log("处理模型列表请求...");
    console.log("OpenAI配置:", { 
      hasDefaultKey: !!config.defaultOutgoingApiKey,
      hasEndpoints: !!(config.openaiEndpoints && config.openaiEndpoints.length > 0),
      endpointsCount: config.openaiEndpoints ? config.openaiEndpoints.length : 0,
      defaultUrl: config.defaultUpstreamUrl
    });
    console.log("Gemini配置:", { 
      enabled: !!config.geminiEnabled, 
      hasApiKey: !!config.geminiApiKey,
      url: config.geminiUpstreamUrl
    });
    console.log("Anthropic配置:", { 
      enabled: !!config.anthropicEnabled, 
      hasApiKey: !!config.anthropicApiKey,
      url: config.anthropicUpstreamUrl
    });
    
    // 只获取已配置的提供商的模型列表
    const promises = [];
    const providerStatuses = {};
    
    // 处理OpenAI模型获取
    if (config.defaultOutgoingApiKey || (config.openaiEndpoints && config.openaiEndpoints.length > 0)) {
      console.log("添加OpenAI模型获取任务...");
      const openaiPromise = getOpenAIModels(request, config)
        .then(models => {
          providerStatuses.openai = {
            success: true,
            count: models?.data?.length || 0
          };
          return models;
        })
        .catch(error => {
          console.error("获取OpenAI模型时出错:", error);
          providerStatuses.openai = {
            success: false,
            error: error.message
          };
          return { object: "list", data: [] };
        });
      
      promises.push(openaiPromise);
    } else {
      console.log("未配置OpenAI API密钥，跳过获取OpenAI模型");
      providerStatuses.openai = {
        success: false,
        reason: "未配置API密钥"
      };
    }
    
    // 处理Gemini模型获取
    if (config.geminiEnabled) {
      console.log("添加Gemini模型获取任务...");
      const geminiPromise = getGeminiModels(request, config)
        .then(models => {
          providerStatuses.gemini = {
            success: true,
            count: models?.data?.length || 0
          };
          return models;
        })
        .catch(error => {
          console.error("获取Gemini模型时出错:", error);
          providerStatuses.gemini = {
            success: false,
            error: error.message
          };
          return { object: "list", data: [] };
        });
      
      promises.push(geminiPromise);
    } else {
      console.log("Gemini API未启用，跳过获取Gemini模型");
      providerStatuses.gemini = {
        success: false,
        reason: "未启用"
      };
    }
    
    // 处理Anthropic模型获取
    if (config.anthropicEnabled) {
      console.log("添加Anthropic模型获取任务...");
      const anthropicPromise = getAnthropicModels(request, config)
        .then(models => {
          providerStatuses.anthropic = {
            success: true,
            count: models?.data?.length || 0
          };
          return models;
        })
        .catch(error => {
          console.error("获取Anthropic模型时出错:", error);
          providerStatuses.anthropic = {
            success: false,
            error: error.message
          };
          return { object: "list", data: [] };
        });
      
      promises.push(anthropicPromise);
    } else {
      console.log("Anthropic API未启用，跳过获取Anthropic模型");
      providerStatuses.anthropic = {
        success: false,
        reason: "未启用"
      };
    }
    
    // 如果没有任何获取任务，返回空列表
    if (promises.length === 0) {
      console.log("没有配置任何API密钥，返回空模型列表");
      return new Response(JSON.stringify({ 
        object: "list", 
        data: []
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    
    console.log(`开始执行${promises.length}个模型获取任务...`);
    // 等待所有模型列表获取完成
    const modelLists = await Promise.all(promises);
    
    // 合并所有模型列表
    const combinedModels = {
      object: "list",
      data: []
    };
    
    // 过滤掉无效结果并合并数据
    for (const list of modelLists) {
      console.log(`处理模型列表结果:`, { 
        isValid: !!(list && list.data && Array.isArray(list.data)),
        modelCount: list && list.data && Array.isArray(list.data) ? list.data.length : 0
      });
      
      if (list && list.data && Array.isArray(list.data)) {
        // 只保留必要的字段，确保符合OpenAI API格式
        const cleanedModels = list.data.map(model => ({
          id: model.id,
          object: "model",
          created: model.created || Math.floor(Date.now() / 1000),
          owned_by: model.owned_by || "unknown"
        }));
        
        combinedModels.data = combinedModels.data.concat(cleanedModels);
      }
    }
    
    console.log(`合并后的模型列表包含${combinedModels.data.length}个模型`);
    
    // 按名称排序
    combinedModels.data.sort((a, b) => a.id.localeCompare(b.id));
    
    return new Response(JSON.stringify(combinedModels), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("处理模型列表请求出错:", error);
    return createErrorResponse(error);
  }
}

// 从多个OpenAI端点获取模型列表
async function getOpenAIModelsFromMultipleEndpoints(config) {
  try {
    console.log("从多个端点获取OpenAI模型列表...");
    const modelPromises = [];
    const manuallyConfiguredModels = [];
    
    // 从每个端点获取模型
    for (const endpoint of config.openaiEndpoints) {
      // 跳过没有API密钥的端点
      if (!endpoint.apiKey) {
        console.log(`跳过没有API密钥的端点: ${endpoint.name || '未命名'}`);
        continue;
      }
      
      console.log(`处理端点: ${endpoint.name || '未命名'}, URL: ${endpoint.url}`);
      
      // 如果端点已配置模型列表，直接使用这些模型，不向上游请求
      if (endpoint.models && Array.isArray(endpoint.models) && endpoint.models.length > 0) {
        console.log(`端点 ${endpoint.name || '未命名'} 已手动配置 ${endpoint.models.length} 个模型，直接使用`);
        // 标准化模型格式
        const configuredModels = endpoint.models.map(modelId => ({
          id: modelId,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "openai"
        }));
        manuallyConfiguredModels.push(...configuredModels);
        continue; // 跳过下面的API请求逻辑
      }
      
      // 获取API密钥（支持负载均衡）
      let apiKey = endpoint.apiKey;
      if (apiKey.includes(',')) {
        const keys = apiKey.split(',').map(k => k.trim()).filter(Boolean);
        if (keys.length > 0) {
          apiKey = keys[Math.floor(Math.random() * keys.length)];
          console.log(`使用负载均衡，从 ${keys.length} 个API密钥中选择一个`);
        } else {
          console.log("API密钥格式错误，没有有效的密钥");
          continue;
        }
      }
      
      // 确保URL格式正确
      let url;
      try {
        // 添加/models路径
        const baseUrl = endpoint.url.endsWith('/') 
          ? endpoint.url.slice(0, -1) 
          : endpoint.url;
        
        url = `${baseUrl}/models`;
      } catch (urlError) {
        console.error(`构建URL时出错, 端点 ${endpoint.name || '未命名'}:`, urlError);
        continue;
      }
      
      // 创建请求
      const upstreamRequest = {
        method: "GET",
        headers: new Headers({
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }),
        url: url
      };
      
      console.log(`从端点 ${endpoint.name || '未命名'} 请求模型列表: ${url}`);
      
      // 发送请求并处理响应
      const modelPromise = (async () => {
        try {
          let response;
          try {
            // 尝试使用nativeFetch发送请求
            response = await nativeFetch(upstreamRequest, upstreamRequest.url);
          } catch (fetchError) {
            console.error(`端点 ${endpoint.name || '未命名'} nativeFetch失败:`, fetchError);
            
            // 尝试使用标准fetch
            try {
              console.log(`尝试使用标准fetch访问端点 ${endpoint.name || '未命名'}...`);
              const fetchOptions = {
                method: "GET",
                headers: new Headers({
                  "Authorization": `Bearer ${apiKey}`,
                  "Content-Type": "application/json"
                })
              };
              
              response = await fetch(url, fetchOptions);
            } catch (stdFetchError) {
              console.error(`端点 ${endpoint.name || '未命名'} 标准fetch也失败:`, stdFetchError);
              return { object: "list", data: [] };
            }
          }
          
          console.log(`端点 ${endpoint.name || '未命名'} 响应状态: ${response.status}`);
          
          if (!response.ok) {
            console.error(`从端点 ${endpoint.name || '未命名'} 获取模型列表失败: ${response.status}`);
            try {
              const errorText = await response.clone().text();
              console.error(`错误详情: ${errorText.substring(0, 200)}`);
            } catch (e) {}
            return { object: "list", data: [] };
          }
          
          let models;
          try {
            models = await response.json();
          } catch (jsonError) {
            console.error(`解析端点 ${endpoint.name || '未命名'} 响应JSON失败:`, jsonError);
            return { object: "list", data: [] };
          }
          
          // 添加端点名称作为标识并标准化数据格式
          if (models && models.data) {
            console.log(`从端点 ${endpoint.name || '未命名'} 获取到 ${models.data.length} 个模型`);
            
            // 标准化模型数据，只保留必要字段
            models.data = models.data.map(model => ({
              id: model.id,
              object: "model",
              created: model.created || Math.floor(Date.now() / 1000),
              owned_by: model.owned_by || "openai"
            }));
          } else {
            console.log(`端点 ${endpoint.name || '未命名'} 返回的数据格式不正确`);
          }
          
          return models;
        } catch (error) {
          console.error(`从端点 ${endpoint.name || '未命名'} 获取模型时出错:`, error);
          return { object: "list", data: [] };
        }
      })();
      
      modelPromises.push(modelPromise);
    }
    
    // 如果所有端点都已手动配置模型，并且没有向上游发送请求
    if (manuallyConfiguredModels.length > 0 && modelPromises.length === 0) {
      console.log(`所有端点都使用手动配置的模型，共 ${manuallyConfiguredModels.length} 个模型`);
      return {
        object: "list",
        data: manuallyConfiguredModels
      };
    }
    
    // 如果没有有效的端点，返回空列表
    if (modelPromises.length === 0 && manuallyConfiguredModels.length === 0) {
      console.log("没有有效的OpenAI端点，返回空列表");
      return {
        object: "list",
        data: []
      };
    }
    
    console.log(`等待 ${modelPromises.length} 个端点的请求完成...`);
    // 等待所有请求完成
    const modelLists = await Promise.all(modelPromises);
    
    // 合并所有模型列表
    const combinedModels = {
      object: "list",
      data: [...manuallyConfiguredModels] // 首先添加手动配置的模型
    };
    
    // 合并数据
    for (const list of modelLists) {
      if (list && list.data && Array.isArray(list.data)) {
        console.log(`合并模型列表，包含 ${list.data.length} 个模型`);
        combinedModels.data = combinedModels.data.concat(list.data);
      }
    }
    
    console.log(`合并后共有 ${combinedModels.data.length} 个模型`);
    return combinedModels;
  } catch (error) {
    console.error("从多个端点获取OpenAI模型时出错:", error);
    throw error;  // 重新抛出异常以便上层函数捕获
  }
}

// 提取API密钥并进行负载均衡，支持多端点路由
function extractOutgoingApiKey(request, config) {
  // 首先尝试从自定义头部获取
  const customApiKey = request.headers.get("X-Outgoing-API-Key");
  if (customApiKey) return customApiKey;
  
  // 如果有多个端点配置，并且请求中包含模型信息，则尝试根据模型选择API密钥
  if (config.openaiEndpoints && config.openaiEndpoints.length > 0) {
    try {
      // 克隆请求以免影响原请求
      const clonedRequest = request.clone();
      
      // 异步获取请求体
      const requestBodyPromise = clonedRequest.json().catch(() => null);
      
      // 设置一个超时，如果无法快速获取请求体，则使用默认API密钥
      const timeoutPromise = new Promise(resolve => {
        setTimeout(() => resolve(null), 50); // 50毫秒超时
      });
      
      // 竞争获取请求体
      const requestBody = Promise.race([requestBodyPromise, timeoutPromise]).catch(() => null);
      
      // 如果成功获取请求体并包含模型名称
      if (requestBody && requestBody.model) {
        const modelName = requestBody.model.toString().toLowerCase().trim();
        
        // 遍历所有端点，查找支持该模型的端点
        for (const endpoint of config.openaiEndpoints) {
          // 如果端点没有指定模型列表或模型列表为空，则支持所有模型
          if (!endpoint.models || endpoint.models.length === 0) {
            // 支持负载均衡（端点API密钥可以包含多个逗号分隔的密钥）
            if (endpoint.apiKey) {
              const keys = endpoint.apiKey.split(',').map(k => k.trim()).filter(Boolean);
              if (keys.length > 0) {
                return keys[Math.floor(Math.random() * keys.length)];
              }
            }
          }
          
          // 如果端点模型列表包含请求的模型
          if (endpoint.models && endpoint.models.some(m => modelName === m.toLowerCase() || modelName.includes(m.toLowerCase()))) {
            // 支持负载均衡
            if (endpoint.apiKey) {
              const keys = endpoint.apiKey.split(',').map(k => k.trim()).filter(Boolean);
              if (keys.length > 0) {
                return keys[Math.floor(Math.random() * keys.length)];
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("提取模型信息以确定API密钥时出错:", error);
    }
    
    // 如果无法根据模型确定端点，则返回第一个端点的API密钥
    if (config.openaiEndpoints.length > 0 && config.openaiEndpoints[0].apiKey) {
      const keys = config.openaiEndpoints[0].apiKey.split(',').map(k => k.trim()).filter(Boolean);
      if (keys.length > 0) {
        return keys[Math.floor(Math.random() * keys.length)];
      }
    }
  }
  
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

// 提取上游URL并支持多端点路由
function extractUpstreamUrl(request, config) {
  // 首先尝试从自定义头部获取
  const customUrl = request.headers.get("X-Upstream-URL");
  if (customUrl) return { url: customUrl, useNativeFetch: true, restrictedModels: null };
  
  // 如果有多个端点配置，并且请求中包含模型信息，则尝试根据模型选择URL
  if (config.openaiEndpoints && config.openaiEndpoints.length > 0) {
    try {
      // 克隆请求以免影响原请求
      const clonedRequest = request.clone();
      
      // 异步获取请求体
      const requestBodyPromise = clonedRequest.json().catch(() => null);
      
      // 设置一个超时，如果无法快速获取请求体，则使用默认URL
      const timeoutPromise = new Promise(resolve => {
        setTimeout(() => resolve(null), 50); // 50毫秒超时
      });
      
      // 竞争获取请求体
      const requestBody = Promise.race([requestBodyPromise, timeoutPromise]).catch(() => null);
      
      // 如果成功获取请求体并包含模型名称
      if (requestBody && requestBody.model) {
        const modelName = requestBody.model.toString().toLowerCase().trim();
        console.log(`处理模型请求: ${modelName}, 开始寻找匹配端点...`);
        
        // 输出所有端点信息以便调试
        console.log("所有可用端点:", config.openaiEndpoints.map(ep => ({
          name: ep.name,
          url: ep.url,
          models: ep.models && ep.models.length > 0 ? ep.models : ["无限制"]
        })));
        
        // 先收集所有匹配情况，然后按优先级选择
        const matchResults = [];
        
        // 检查每个端点
        for (let i = 0; i < config.openaiEndpoints.length; i++) {
          const endpoint = config.openaiEndpoints[i];
          if (!endpoint.url) continue;
          
          // 端点没有模型限制 - 通用端点
          if (!endpoint.models || endpoint.models.length === 0) {
            matchResults.push({
              endpoint: endpoint,
              matchType: "generic",
              index: i,
              priority: 3 // 最低优先级
            });
            continue;
          }
          
          // 检查完全匹配
          const exactMatchModel = endpoint.models.find(m => 
            m.toLowerCase().trim() === modelName
          );
          
          if (exactMatchModel) {
            matchResults.push({
              endpoint: endpoint,
              matchType: "exact",
              matchedModel: exactMatchModel,
              index: i,
              priority: 1 // 最高优先级
            });
            continue;
          }
          
          // 检查部分匹配
          const partialMatchModel = endpoint.models.find(m => {
            const lowerM = m.toLowerCase().trim();
            return modelName.includes(lowerM) || lowerM.includes(modelName);
          });
          
          if (partialMatchModel) {
            matchResults.push({
              endpoint: endpoint,
              matchType: "partial",
              matchedModel: partialMatchModel,
              index: i,
              priority: 2 // 中等优先级
            });
          }
        }
        
        // 根据优先级排序：1.完全匹配 2.部分匹配 3.通用端点
        matchResults.sort((a, b) => a.priority - b.priority);
        
        // 输出匹配结果
        console.log("端点匹配结果:", matchResults.map(r => ({
          name: r.endpoint.name,
          matchType: r.matchType,
          matchedModel: r.matchedModel || "N/A",
          priority: r.priority
        })));
        
        // 选择最佳匹配
        if (matchResults.length > 0) {
          const bestMatch = matchResults[0];
          console.log(`为模型 ${modelName} 选择端点: ${bestMatch.endpoint.name} (匹配类型: ${bestMatch.matchType})`);
          return { 
            url: bestMatch.endpoint.url, 
            useNativeFetch: bestMatch.endpoint.useNativeFetch !== undefined ? bestMatch.endpoint.useNativeFetch : true,
            restrictedModels: bestMatch.endpoint.models
          };
        }
        
        console.log(`未找到匹配端点，使用第一个有效端点`);
      }
    } catch (error) {
      console.error("提取模型信息以确定上游URL时出错:", error);
    }
  }
  
  // 如果没有找到匹配的端点或出错，则使用第一个有效的端点URL
  if (config.openaiEndpoints && config.openaiEndpoints.length > 0) {
    for (const endpoint of config.openaiEndpoints) {
      if (endpoint.url) {
        return { 
          url: endpoint.url, 
          useNativeFetch: endpoint.useNativeFetch !== undefined ? endpoint.useNativeFetch : true,
          restrictedModels: endpoint.models && endpoint.models.length > 0 ? endpoint.models : null
        };
      }
    }
  }
  
  // 最后才回退到默认URL
  return { 
    url: config.defaultUpstreamUrl || "https://api.openai.com/v1", 
    useNativeFetch: true,
    restrictedModels: null
  };
}

// 验证代理API密钥
function validateProxyApiKey(request, config) {
  // 获取请求路径
  const url = new URL(request.url);
  const path = url.pathname + url.search;
  
  // 如果是模型列表请求，可以放宽验证
  const isModelsRequest = path.includes('/models');
  
  // 如果未配置代理API密钥，则不验证
  if (!config.proxyApiKey) {
    console.log(`API密钥验证: 未配置代理API密钥，验证通过`);
    return true;
  }
  
  // 获取请求中的密钥
  const authHeader = request.headers.get("Authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKey = bearerMatch ? bearerMatch[1].trim() : "";
  
  // 检查API密钥是否匹配
  const isValid = apiKey === config.proxyApiKey;
  
  // 对于模型列表请求，即使API密钥不匹配也允许通过
  // 这样可以确保客户端始终能获取模型列表
  if (isModelsRequest && !isValid) {
    console.log(`API密钥验证: 模型列表请求，即使密钥不匹配也允许通过`);
    return true;
  }
  
  console.log(`API密钥验证: ${isValid ? '通过' : '失败'}`);
  return isValid;
}

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
  let hasMultiModalContent = false;
  let multimodalContent = [];
  
  // 从candidates数组中提取文本内容
  if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
    const candidate = geminiResponse.candidates[0];
    
    // 处理Gemini API 不同可能的响应结构
    if (candidate.content && candidate.content.parts) {
      // 检查是否有多模态内容
      const parts = candidate.content.parts;
      if (parts.some(part => part.inlineData || part.fileData)) {
        hasMultiModalContent = true;
        // 处理多模态内容
        for (const part of parts) {
          if (part.text) {
            multimodalContent.push({
              type: "text",
              text: part.text
            });
          } else if (part.inlineData) {
            // 处理嵌入的图片数据
            multimodalContent.push({
              type: "image_url",
              image_url: {
                url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`
              }
            });
          }
        }
      } else {
        // 普通文本内容
        content = parts.map(part => part.text || "").join("");
      }
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
        content: hasMultiModalContent ? multimodalContent : content
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
    let hasMultiModalParts = false;
    let multimodalParts = [];
    
    if (typeof geminiResponse.content === 'string') {
      contentText = geminiResponse.content;
    } else if (geminiResponse.content.parts) {
      // 检查是否有多模态内容
      const parts = geminiResponse.content.parts;
      if (parts.some(part => part.inlineData || part.fileData)) {
        hasMultiModalParts = true;
        // 处理多模态内容
        for (const part of parts) {
          if (part.text) {
            multimodalParts.push({
              type: "text",
              text: part.text
            });
          } else if (part.inlineData) {
            // 处理嵌入的图片数据
            multimodalParts.push({
              type: "image_url",
              image_url: {
                url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`
              }
            });
          }
        }
      } else {
        contentText = parts.map(part => part.text || "").join("");
      }
    } else {
      contentText = JSON.stringify(geminiResponse.content);
    }
    
    openAIResponse.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: hasMultiModalParts ? multimodalParts : contentText
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
    let hasMultiModalContent = false;
    let multimodalContent = [];
    
    // 检查是否有多模态内容
    const hasImages = anthropicResponse.content.some(block => block.type === "image");
    
    if (hasImages) {
      hasMultiModalContent = true;
      // 合并所有内容块，并处理多模态内容
      for (const block of anthropicResponse.content) {
        if (block.type === "text") {
          multimodalContent.push({
            type: "text",
            text: block.text || ""
          });
        } else if (block.type === "image") {
          // 处理图片内容
          if (block.source && block.source.type === "base64") {
            multimodalContent.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type || 'image/jpeg'};base64,${block.source.data}`
              }
            });
          } else if (block.source && block.source.type === "url") {
            multimodalContent.push({
              type: "image_url",
              image_url: {
                url: block.source.url
              }
            });
          }
        }
      }
    } else {
      // 合并所有文本内容块
      for (const block of anthropicResponse.content) {
        if (block.type === "text") {
          content += block.text || "";
        }
      }
    }
    
    openAIResponse.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: hasMultiModalContent ? multimodalContent : content
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
  // 创建转换流
  const { readable, writable } = new TransformStream();
  
  // 获取当前模型名称
  let currentModel = "unknown";
  try {
    // 从我们添加的自定义头部获取模型名称
    const customModelName = response.headers.get("x-model-name");
    if (customModelName) {
      currentModel = customModelName.toLowerCase();
      console.log(`从自定义头部获取模型名称: ${currentModel}`);
    }
    // 如果没有自定义头部，尝试从其他头部获取
    else {
      // 从URL路径获取模型信息
      const urlPath = new URL(response.url).pathname;
      if (urlPath.includes('completions') || urlPath.includes('chat/completions')) {
        // 如果在路径中，尝试从路径中提取
        currentModel = urlPath.split('/').pop() || "unknown";
      }
      
      // 从标准头部获取模型信息
      const modelHeader = response.headers.get("x-model") || response.headers.get("x-openai-model");
      if (modelHeader) {
        currentModel = modelHeader.toLowerCase();
      }
    }
    
    // 从响应中获取请求ID，用于日志跟踪
    const reqId = response.headers.get("x-request-id") || "unknown";
    console.log(`处理流式响应: 模型=${currentModel}, 请求ID=${reqId}`);
  } catch (e) {
    console.error("获取模型名称出错:", e);
  }
  
  // 检查是否禁用该模型的流式优化
  const shouldDisableOptimization = config.disableOptimizationModels && 
    Array.isArray(config.disableOptimizationModels) &&
    config.disableOptimizationModels.some(model => {
      if (!model || typeof model !== 'string') return false;
      
      const lowerModel = model.toLowerCase().trim();
      const lowerCurrentModel = currentModel.toLowerCase().trim();
      
      // 注册在日志中，便于调试
      console.log(`比较模型: ${lowerCurrentModel} 与禁用列表项: ${lowerModel}`);
      
      const isMatch = lowerCurrentModel === lowerModel || 
             lowerCurrentModel.includes(lowerModel) || 
             lowerModel.includes(lowerCurrentModel);
             
      if (isMatch) {
        console.log(`模型 ${currentModel} 匹配禁用项 ${lowerModel}`);
      }
      
      return isMatch;
    });
  
  // 记录禁用优化状态
  console.log(`禁用流式优化状态: ${shouldDisableOptimization}, 配置的禁用模型列表:`, 
    Array.isArray(config.disableOptimizationModels) ? config.disableOptimizationModels : 'undefined');
  
  // 如果禁用优化，直接传递原始响应流
  if (shouldDisableOptimization) {
    console.log(`模型 ${currentModel} 在禁用流式优化列表中，直接传递原始响应`);
    
    // 启动异步处理，直接复制原始流
    (async () => {
      const reader = response.body.getReader();
      const writer = writable.getWriter();
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.close();
            break;
          }
          await writer.write(value);
        }
      } catch (err) {
        console.error("直接传递流时出错:", err);
        try { writable.abort(err); } catch (e) {}
      }
    })();
    
    return new Response(readable, {
      headers: response.headers
    });
  }
  
  // 以下是正常的流优化处理...
  
  // 设置监控变量
  let streamActive = true;
  let lastActivityTime = Date.now();
  let heartbeatIntervalId = null;
  
  // 心跳检测
  heartbeatIntervalId = setInterval(() => {
    if (!streamActive) {
      clearInterval(heartbeatIntervalId);
      return;
    }
    
    const inactiveTime = Date.now() - lastActivityTime;
    if (inactiveTime > 30000) {
      console.log("发送心跳包保持连接...");
      try {
        // 不要在这里尝试获取writer，避免锁定问题
        // 只记录日志，实际心跳在processStreamedResponse中处理
      } catch (err) {
        console.error("心跳处理错误:", err);
      }
    }
  }, 15000);
  
  // 启动异步处理，不等待其完成
  (async () => {
    try {
      await streamProcessor(response.body, writable, apiType, config, () => {
        lastActivityTime = Date.now();
      });
    } catch (err) {
      console.error("Stream处理发生错误:", err);
      try {
        // 如果流仍然激活，尝试发送错误信息
        if (streamActive && !writable.locked) {
          const writer = writable.getWriter();
          try {
            const encoder = new TextEncoder();
            const errorMsg = JSON.stringify({
              error: {
                message: `流处理错误: ${err.message}`,
                type: "stream_error",
                code: 500
              }
            });
            
            await writer.write(encoder.encode(`data: ${errorMsg}\n\n`));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            await writer.close();
          } catch (e) {
            console.error("发送错误信息失败:", e);
            try { writable.abort(err); } catch (e) {}
          }
        } else {
          console.log("流已关闭或已锁定，跳过错误处理");
        }
      } catch (e) {
        console.error("错误处理失败:", e);
      }
    } finally {
      streamActive = false;
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
      }
    }
  })();
  
  // 立即返回响应，后台继续处理
  return addCorsHeaders(new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  }));
}

// 新的流处理器函数
async function streamProcessor(inputStream, outputStream, apiType, config, updateActivity) {
  const reader = inputStream.getReader();
  const writer = outputStream.getWriter();
  
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  
  let buffer = "";
  let lastChunkTime = Date.now();
  let recentChunkSizes = [];
  let currentDelay = config.minDelay;
  let contentReceived = false;
  
  // 添加用于监测流结束信号的变量
  let isStreamEnding = false;
  let noContentCount = 0;
  let totalContentReceived = 0;
  // 添加变量来跟踪最大单个块大小
  let maxSingleChunkSize = 0;
  
  // 添加快速输出模式标志
  let fastOutputMode = false;
  
  // 添加安全的活动更新函数
  const safeUpdateActivity = typeof updateActivity === 'function' 
    ? updateActivity 
    : () => {};
  
  try {
    console.log(`开始处理${apiType}流式响应`);
    
    while (true) {
      let readResult;
      
      try {
        readResult = await reader.read();
        safeUpdateActivity();
      } catch (readError) {
        console.error("读取流错误:", readError);
        throw new Error(`流读取失败: ${readError.message}`);
      }
      
      const { done, value } = readResult;
      
      if (done) {
        console.log("流读取完成");
        // 标记为流结束
        isStreamEnding = true;
        if (buffer.length > 0) {
          await processBuffer(buffer, writer, encoder, apiType, config, isStreamEnding);
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        break;
      }
      
      // 更新延迟计算
      const currentTime = Date.now();
      const timeSinceLastChunk = currentTime - lastChunkTime;
      lastChunkTime = currentTime;
      
      if (value && value.length) {
        // 更新延迟计算
        recentChunkSizes.push(value.length);
        if (recentChunkSizes.length > config.chunkBufferSize) {
          recentChunkSizes.shift();
        }
        
        // 更新最大单个块大小和总接收内容
        maxSingleChunkSize = Math.max(maxSingleChunkSize, value.length);
        totalContentReceived += value.length;
        
        // 检查是否应该启用快速输出模式 - 基于单个块的大小判断
        if (!fastOutputMode && config.minContentLengthForFastOutput && 
            maxSingleChunkSize > config.minContentLengthForFastOutput) {
          console.log("启用快速输出模式，单个响应块大小已超过阈值:", maxSingleChunkSize);
          fastOutputMode = true;
        }
        
        // 计算新的延迟
        const avgChunkSize = recentChunkSizes.reduce((a, b) => a + b, 0) / recentChunkSizes.length;
        
        // 根据不同条件决定当前延迟
        if (fastOutputMode && config.fastOutputDelay !== undefined) {
          // 快速输出模式
          currentDelay = Math.max(config.minDelay || 5, config.fastOutputDelay);
        } else {
          // 正常延迟计算
          currentDelay = adaptDelay(avgChunkSize, timeSinceLastChunk, config, isStreamEnding);
        }
        
        // 处理接收到的数据
        buffer += decoder.decode(value, { stream: true });
        
        // 按行处理
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        if (lines.length > 0) {
          // 检测是否有实际内容
          if (!contentReceived) {
            const hasContent = lines.some(line => 
              line.trim() && line.startsWith("data: ") && line.slice(6).trim() !== ""
            );
            if (hasContent) {
              contentReceived = true;
              console.log("检测到有效内容");
            }
          }
          
          // 检查每行是否包含模型原生的结束标志
          if (!isStreamEnding) { // 只有在尚未检测到结束标志时才检查
            for (const line of lines) {
              try {
                if (line.startsWith("data: ")) {
                  const data = line.slice(6).trim();
                  // 确保是JSON格式并包含结束标志
                  if (data && data !== "[DONE]") {
                    try {
                      const jsonData = JSON.parse(data);
                      // 检查OpenAI格式的结束标志
                      if (jsonData.choices && jsonData.choices.length > 0) {
                        const choice = jsonData.choices[0];
                        // 正确检测finish_reason是否存在且有值
                        if (choice.finish_reason || 
                            (choice.delta && choice.delta.finish_reason) ||
                            choice.stop_reason || 
                            choice.finishReason || 
                            jsonData.message_stop) {
                          isStreamEnding = true;
                          console.log("检测到模型输出完成标志:", JSON.stringify(jsonData));
                          break;
                        }
                      }
                    } catch (e) {
                      // JSON解析错误，可能不是有效的JSON或者是[DONE]
                      if (data === "[DONE]") {
                        isStreamEnding = true;
                        console.log("检测到[DONE]结束标志");
                        break;
                      }
                    }
                  }
                }
              } catch (lineError) {
                console.error("检测结束标志时出错:", lineError);
              }
            }
          }
          
          // 处理每一行
          for (const line of lines) {
            try {
              if (apiType === "openai") {
                await processSSELine(line, writer, encoder, currentDelay, config, isStreamEnding);
              } else if (apiType === "gemini") {
                await processGeminiSSELine(line, writer, encoder, currentDelay, config, isStreamEnding);
              } else if (apiType === "anthropic") {
                await processAnthropicSSELine(line, writer, encoder, currentDelay, config, isStreamEnding);
              }
            } catch (lineError) {
              console.error(`处理行出错:`, lineError);
              // 继续处理其他行
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("流处理错误:", e);
    try {
      const errorMsg = JSON.stringify({
        error: {
          message: `流处理错误: ${e.message}`,
          type: "stream_error",
          code: 500
        }
      });
      await writer.write(encoder.encode(`data: ${errorMsg}\n\n`));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (writeError) {
      console.error("写入错误信息失败:", writeError);
    }
  } finally {
    console.log("流处理结束");
    try {
      await writer.close();
    } catch (e) {
      console.error("关闭writer失败:", e);
    }
    try {
      reader.releaseLock();
    } catch (e) {
      console.error("释放reader锁失败:", e);
    }
  }
}

// 处理缓冲区
async function processBuffer(buffer, writer, encoder, apiType, config, isStreamEnding = true) {
  if (!buffer.trim()) return;
  
  try {
    // 缓冲区处理时默认将isStreamEnding设为true，因为通常是在流结束时处理
    if (apiType === "openai") {
      await processSSELine(buffer, writer, encoder, config.minDelay, config, isStreamEnding);
    } else if (apiType === "gemini") {
      await processGeminiSSELine(buffer, writer, encoder, config.minDelay, config, isStreamEnding);
    } else if (apiType === "anthropic") {
      await processAnthropicSSELine(buffer, writer, encoder, config.minDelay, config, isStreamEnding);
    }
  } catch (e) {
    console.error(`处理缓冲区出错: ${e.message}`);
  }
}

// 处理OpenAI格式的SSE行
async function processSSELine(line, writer, encoder, delay, config, isStreamEnding) {
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
          // 逐字符发送内容，传递config和isStreamEnding参数
          await sendContentCharByChar(content, jsonData, writer, encoder, delay, isCompletionAPI, config, isStreamEnding);
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
async function processGeminiSSELine(line, writer, encoder, delay, config, isStreamEnding) {
  if (!line.trim()) {
    await writer.write(encoder.encode("\n"));
    return;
  }

  if (line.startsWith("data: ")) {
    const data = line.slice(6);
    console.log("Gemini原始数据:", data.substring(0, 100));  // 只打印部分内容

    if (data === "[DONE]") {
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      return;
    }

    try {
      // 处理可能的空数据
      if (!data || data.trim() === "") {
        console.log("收到空数据行，跳过处理");
        return;
      }
      
      const geminiData = JSON.parse(data);
      
      // 检查是否有错误字段
      if (geminiData.error) {
        console.error("Gemini响应中包含错误:", geminiData.error);
        
        // 将错误信息编码为OpenAI格式并发送给客户端
        const errorResponse = {
          id: `error-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gemini",
          choices: [{
            index: 0,
            delta: { content: `[Gemini API错误] ${geminiData.error.message || JSON.stringify(geminiData.error)}` },
            finish_reason: "error"
          }]
        };
        
        await writer.write(encoder.encode(`data: ${JSON.stringify(errorResponse)}\n\n`));
        return;
      }
      
      // 提取真实的模型名称
      let modelName = "gemini";
      if (geminiData.modelId) {
        modelName = geminiData.modelId;
      } else if (geminiData.candidates && geminiData.candidates[0] && geminiData.candidates[0].modelId) {
        modelName = geminiData.candidates[0].modelId;
      }

      // 检查是否有候选项
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
        } else if (candidate.content?.text) { 
          // 兼容新版Gemini API可能直接返回text的情况
          textContent = candidate.content.text;
        } else if (candidate.text) {
          // 兼容旧版API
          textContent = candidate.text;
        }

        if (textContent) {
          // 创建OpenAI格式的响应对象
          const openAIFormat = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index,
              delta: {
                content: textContent
              },
              finish_reason: null
            }]
          };

          // 使用sendContentCharByChar函数处理流式输出
          await sendContentCharByChar(textContent, openAIFormat, writer, encoder, delay, false, config, isStreamEnding);
        } else {
          console.log("未从Gemini响应中提取到文本内容");
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
            model: modelName,
            choices: [{
              index,
              delta: {},
              finish_reason: reasonsMap[candidate.finishReason] || candidate.finishReason
            }]
          };
          
          await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        }
      } else {
        console.log("Gemini响应中没有候选项");
      }
    } catch (e) {
      console.error("解析Gemini响应出错:", e, "原始数据:", data.substring(0, 200));
      // 如果解析失败，将原始数据传递出去，避免完全失败
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    }
  } else {
    // 对于非data行，记录但不发送
    console.log("非data行:", line.substring(0, 50));
  }
}

// 处理Anthropic格式的SSE行并转换为OpenAI格式
async function processAnthropicSSELine(line, writer, encoder, delay, config, isStreamEnding) {
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
          await sendContentCharByChar(textContent, openAIFormat, writer, encoder, delay, false, config, isStreamEnding);
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
function adaptDelay(chunkSize, timeSinceLastChunk, config, isStreamEnding) {
  if (chunkSize <= 0) return config.minDelay;
  
  // 流结束时使用finalLowDelay
  if (isStreamEnding && config.finalLowDelay !== undefined) {
    return Math.max(config.minDelay, config.finalLowDelay);
  }
  
  // 确保配置值有效
  const minDelay = Math.max(1, config.minDelay || 5);
  const maxDelay = Math.max(minDelay, config.maxDelay || 40);
  const adaptiveDelayFactor = Math.max(0, Math.min(2, config.adaptiveDelayFactor || 0.5));
  
  // 块大小反比因子:块越大,字符间延迟越小
  // 改进算法，使块大小影响更加平滑
  const sizeInverseFactor = 1 + Math.log(1 + Math.min(chunkSize, 200)) / Math.log(20);
  const normalizedSizeFactor = 1 / Math.max(0.5, Math.min(2.0, sizeInverseFactor));
  
  // 时间因子:接收间隔越长,延迟越大
  // 限制时间范围，避免极端值
  const normalizedTime = Math.min(2000, Math.max(50, timeSinceLastChunk));
  const timeFactor = Math.sqrt(normalizedTime / 300);
  
  // 组合因子计算最终延迟
  const adaptiveDelay = minDelay + 
    (maxDelay - minDelay) * 
    normalizedSizeFactor * timeFactor * adaptiveDelayFactor;
  
  // 确保延迟在允许范围内，并添加偏移以增加随机性
  const baseDelay = Math.min(maxDelay, Math.max(minDelay, adaptiveDelay));
  
  // 添加轻微随机变化（±10%）以使输出更自然
  const randomFactor = 0.9 + (Math.random() * 0.2);
  return baseDelay * randomFactor;
}

// 逐字符发送内容
async function sendContentCharByChar(content, originalJson, writer, encoder, delay, isCompletionAPI, config, isStreamEnding) {
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
      // 优化：如果是流结束且配置了finalLowDelay，使用finalLowDelay
      const actualDelay = isStreamEnding && config && config.finalLowDelay !== undefined
        ? Math.max(config.minDelay || 5, config.finalLowDelay)
        : delay;
      
      await new Promise(resolve => setTimeout(resolve, actualDelay));
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

// 处理退出登录请求
async function handleLogoutRequest(request, env) {
  // 创建一个响应清除cookie
  const response = new Response(JSON.stringify({ success: true, message: "已退出登录" }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
  
  // 添加两个Set-Cookie头，分别清除不同路径的cookie
  response.headers.set('Set-Cookie', 'admin_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; HttpOnly; SameSite=Strict; Secure');
  response.headers.append('Set-Cookie', 'admin_session=; Path=/admin; Expires=Thu, 01 Jan 1970 00:00:01 GMT; HttpOnly; SameSite=Strict; Secure');
  
  return response;
}

// 处理会话检查请求
async function handleCheckSessionRequest(request, env) {
  const isLoggedIn = await checkAdminSession(request, env);
  return new Response(JSON.stringify({ isLoggedIn }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// 获取OpenAI模型列表
async function getOpenAIModels(request, config) {
  try {
    console.log("开始获取OpenAI模型列表...");
    
    // 如果有多个OpenAI端点配置，则从所有端点获取模型
    if (config.openaiEndpoints && config.openaiEndpoints.length > 0) {
      console.log(`使用多端点模式获取OpenAI模型，端点数量: ${config.openaiEndpoints.length}`);
      
      // 输出端点详情用于调试
      config.openaiEndpoints.forEach((endpoint, index) => {
        console.log(`端点 #${index+1}: ${endpoint.name || '未命名'}`);
        console.log(`  URL: ${endpoint.url}`);
        console.log(`  API密钥存在: ${!!endpoint.apiKey}`);
        console.log(`  支持的模型数量: ${endpoint.models ? endpoint.models.length : '全部'}`);
      });
      
      return await getOpenAIModelsFromMultipleEndpoints(config);
    } else {
      // 兼容旧版配置，使用默认端点
      console.log("使用单端点模式获取OpenAI模型...");
      
      // 确保默认URL存在
      if (!config.defaultUpstreamUrl) {
        config.defaultUpstreamUrl = "https://api.openai.com/v1";
        console.log(`未配置默认URL，使用默认值: ${config.defaultUpstreamUrl}`);
      }
      
      const upstreamUrlInfo = extractUpstreamUrl(request, config);
      const outgoingApiKey = extractOutgoingApiKey(request, config);
      
      console.log(`上游URL信息:`, {
        url: upstreamUrlInfo.url,
        useNativeFetch: upstreamUrlInfo.useNativeFetch,
        hasRestrictedModels: !!upstreamUrlInfo.restrictedModels
      });
      
      // 如果没有API密钥,则跳过
      if (!outgoingApiKey) {
        console.log("没有找到有效的OpenAI API密钥，返回空列表");
        return { object: "list", data: [] };
      }
      
      // 使用URL构建请求
      let url;
      try {
        // 确保URL格式正确，自动添加/models路径
        const baseUrl = upstreamUrlInfo.url.endsWith('/') 
          ? upstreamUrlInfo.url.slice(0, -1) 
          : upstreamUrlInfo.url;
        
        url = `${baseUrl}/models`;
        console.log(`构建的模型列表请求URL: ${url}`);
      } catch (urlError) {
        console.error("构建URL时出错:", urlError);
        url = "https://api.openai.com/v1/models";
        console.log(`回退到默认URL: ${url}`);
      }
      
      const upstreamRequest = {
        method: "GET",
        headers: new Headers({
          "Authorization": `Bearer ${outgoingApiKey}`,
          "Content-Type": "application/json"
        }),
        url: url
      };
      
      console.log(`发送模型列表请求到: ${upstreamRequest.url}`);
      
      let response;
      try {
        // 尝试使用nativeFetch发送请求
        response = await nativeFetch(upstreamRequest, upstreamRequest.url);
      } catch (fetchError) {
        console.error(`nativeFetch失败: ${fetchError.message}`);
        
        // 尝试使用标准fetch
        try {
          console.log("尝试使用标准fetch...");
          const fetchOptions = {
            method: "GET",
            headers: new Headers({
              "Authorization": `Bearer ${outgoingApiKey}`,
              "Content-Type": "application/json"
            })
          };
          
          response = await fetch(url, fetchOptions);
        } catch (stdFetchError) {
          console.error(`标准fetch也失败: ${stdFetchError.message}`);
          throw new Error(`无法连接到OpenAI API: ${stdFetchError.message}`);
        }
      }
      
      console.log(`模型列表请求响应状态: ${response.status}`);
      
      if (!response.ok) {
        console.error(`获取模型列表失败: ${response.status} ${response.statusText}`);
        try {
          const errorText = await response.clone().text();
          console.error(`错误详情: ${errorText.substring(0, 200)}`);
        } catch (e) {
          console.error(`无法读取错误详情: ${e.message}`);
        }
        return { object: "list", data: [] };
      }
      
      let models;
      try {
        models = await response.json();
      } catch (jsonError) {
        console.error(`解析响应JSON失败: ${jsonError.message}`);
        try {
          const text = await response.clone().text();
          console.error(`响应内容: ${text.substring(0, 200)}...`);
        } catch (e) {}
        return { object: "list", data: [] };
      }
      
      console.log(`成功获取到 ${models.data ? models.data.length : 0} 个OpenAI模型`);
      
      // 标准化模型数据，只保留必要字段
      if (models && models.data && Array.isArray(models.data)) {
        models.data = models.data.map(model => ({
          id: model.id,
          object: "model",
          created: model.created || Math.floor(Date.now() / 1000),
          owned_by: model.owned_by || "openai"
        }));
      }
      
      return models;
    }
  } catch (error) {
    console.error("获取OpenAI模型列表时出错:", error);
    throw error;  // 重新抛出异常以便上层函数捕获
  }
}

// 解析请求体并检查是否是流式请求
async function parseRequestBody(request) {
  let requestBody = {};
  let isStreamRequest = false;
  
  try {
    // 只处理POST请求
    if (request.method === 'POST') {
      // 克隆请求以免影响原请求
      const clonedRequest = request.clone();
      
      try {
        // 解析JSON请求体
        requestBody = await clonedRequest.json();
        
        // 检查是否请求流式输出
        isStreamRequest = !!requestBody.stream;
      } catch (e) {
        console.error("解析请求体失败:", e);
      }
    }
  } catch (e) {
    console.error("处理请求体时发生错误:", e);
  }
  
  return { requestBody, isStreamRequest };
}

// 检查是否是获取模型列表的请求
function isModelsRequest(path) {
  return path.includes('/models') || path.includes('/v1/models');
}

// 创建发送到上游API的请求
function createUpstreamRequest(url, originalRequest, requestBody, apiKey) {
  // 构建请求头
  const headers = new Headers();
  
  // 如果请求体中有模型名称，添加到自定义头部中
  if (requestBody && requestBody.model) {
    headers.set('x-model-name', requestBody.model.toString());
    console.log(`将模型名称 ${requestBody.model} 添加到请求头`);
  }
  
  // 复制所有原始请求头
  try {
    for (const [key, value] of originalRequest.headers) {
      // 跳过一些特殊的请求头
      if (!['host', 'connection', 'authorization'].includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  } catch (headerError) {
    console.error("复制原始请求头时出错:", headerError);
    
    // 如果标准迭代失败，尝试其他方法
    try {
      if (originalRequest.headers.get && typeof originalRequest.headers.get === 'function') {
        // 如果有get方法，可能还有keys方法
        if (originalRequest.headers.keys && typeof originalRequest.headers.keys === 'function') {
          const headerNames = Array.from(originalRequest.headers.keys());
          for (const key of headerNames) {
            if (!['host', 'connection', 'authorization'].includes(key.toLowerCase())) {
              const value = originalRequest.headers.get(key);
              if (value !== null && value !== undefined) {
                headers.set(key, value);
              }
            }
          }
        }
      } else if (typeof originalRequest.headers === 'object') {
        // 尝试作为普通对象处理
        for (const [key, value] of Object.entries(originalRequest.headers)) {
          if (!['host', 'connection', 'authorization'].includes(key.toLowerCase())) {
            headers.set(key, value);
          }
        }
      }
    } catch (e) {
      console.error("替代方法处理请求头也失败:", e);
    }
  }
  
  // 设置授权头
  if (apiKey) {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }
  
  // 设置内容类型
  headers.set('Content-Type', 'application/json');
  
  // 构建新的请求
  return {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    url: url
  };
}

// 创建Anthropic请求
async function createAnthropicRequest(request, requestBody, config) {
  // 获取Anthropic API密钥
  const apiKey = getAnthropicApiKey(request, config);
  
  // 构建请求头
  const headers = new Headers();
  headers.set('x-api-key', apiKey);
  headers.set('anthropic-version', '2023-06-01');
  headers.set('Content-Type', 'application/json');
  
  // 转换请求体格式为Anthropic格式
  const anthropicBody = {
    model: requestBody.model.replace(/^claude-/, ''),  // 移除前缀，如果有的话
    prompt: `\n\nHuman: ${requestBody.messages.map(msg => msg.content).join('\n')}\n\nAssistant:`,
    max_tokens_to_sample: requestBody.max_tokens || 4000,
    temperature: requestBody.temperature || 0.7,
    stream: requestBody.stream
  };
  
  // 构建请求URL
  const url = `${config.anthropicUpstreamUrl}/v1/complete`;
  
  // 返回请求配置
  return {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
    url,
    useNativeFetch: config.anthropicUseNativeFetch // 使用配置中的原生Fetch选项
  };
}

// 创建Gemini请求
async function createGeminiRequest(request, requestBody, config) {
  // 获取Gemini API密钥
  const apiKey = getGeminiApiKey(request, config);
  
  // 从请求中提取模型名称
  let modelName = requestBody.model || 'gemini-pro';
  
  // 标准化模型名称格式
  if (!modelName.startsWith('gemini-')) {
    modelName = 'gemini-' + modelName;
  }
  
  // 确保URL格式正确，对于Gemini API，models/前缀是必需的
  if (!modelName.startsWith('models/')) {
    modelName = `models/${modelName}`;
  }

  console.log(`使用Gemini模型: ${modelName}, 流式请求: ${requestBody.stream ? '是' : '否'}`);
  
  // 处理消息，Gemini不支持system角色
  let processedMessages = [];
  let systemInstruction = null;
  
  // 收集所有system消息并将它们处理为systemInstruction
  for (const msg of requestBody.messages) {
    if (msg.role === 'system') {
      // 创建系统指令，使用Gemini API预期的格式
      systemInstruction = {
        parts: [{ text: msg.content }]
      };
    } else {
      processedMessages.push(msg);
    }
  }
  
  // 如果没有非系统消息，添加一个默认的用户消息
  if (processedMessages.length === 0) {
    processedMessages.push({
      role: 'user',
      content: 'Hello'
    });
  }
  
  console.log(`处理后的消息数: ${processedMessages.length}`);
  
  // 构建对话格式
  const contents = processedMessages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  
  // 设置请求头，包括必要的API客户端标识
  const headers = {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
    'x-goog-api-client': 'genai-js/0.1.0'
  };
  
  // 构建基础URL，确保没有末尾斜杠
  let baseUrl = config.geminiUpstreamUrl;
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  
  // 根据是否为流式请求构建不同的URL和请求体
  const isStreamRequest = requestBody.stream === true;
  const TASK = isStreamRequest ? "streamGenerateContent" : "generateContent";
  let url = `${baseUrl}/v1beta/${modelName}:${TASK}`;
  
  // 为流式请求添加SSE参数
  if (isStreamRequest) {
    url += "?alt=sse";
  }
  
  // 构建请求体
  const geminiBody = {
    contents: contents,
    generationConfig: {
      temperature: requestBody.temperature || 0.7,
      maxOutputTokens: requestBody.max_tokens || 2048,
      topP: requestBody.top_p || 0.95,
      topK: requestBody.top_k || 40
    },
    // 安全设置调整为BLOCK_NONE，防止截断回复
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
    ]
  };
  
  // 如果有系统指令，添加到请求体
  if (systemInstruction) {
    geminiBody.systemInstruction = systemInstruction;
  }
  
  // 打印请求信息便于调试
  console.log(`Gemini请求URL: ${url}`);
  console.log(`Gemini请求体: ${JSON.stringify(geminiBody).substring(0, 200)}...`);
  
  // 返回请求配置
  return {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(geminiBody),
    url,
    useNativeFetch: config.geminiUseNativeFetch // 使用配置中的原生Fetch选项
  };
}

// 将非OpenAI API的响应转换为OpenAI格式
async function convertToOpenAIResponse(response, apiType, config) {
  try {
    // 获取响应体
    const responseBody = await response.json();
    
    // 根据API类型进行转换
    let convertedBody;
    
    if (apiType === 'gemini') {
      convertedBody = convertGeminiToOpenAIFormat(responseBody);
    } else if (apiType === 'anthropic') {
      convertedBody = convertAnthropicToOpenAIFormat(responseBody);
    } else {
      // 如果是未知API类型，返回原始响应
      return new Response(JSON.stringify(responseBody), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // 返回转换后的响应
    return new Response(JSON.stringify(convertedBody), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error("convertToOpenAIResponse error:", error);
    // 返回友好的错误响应
    return new Response(JSON.stringify({
      error: {
        message: "Error converting response: " + error.message,
        type: "conversion_error",
        code: 500
      }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// 安全地将Headers对象转换为字符串
function safeHeadersToString(headers) {
  if (!headers) return '';
  
  try {
    // 标准方法
    return Array.from(headers.entries())
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
  } catch (e) {
    console.error("使用entries方法转换headers失败，尝试替代方法", e);
    
    try {
      // 替代方法1: 使用keys和get
      if (headers.keys && typeof headers.keys === 'function' &&
          headers.get && typeof headers.get === 'function') {
        return Array.from(headers.keys())
          .map(k => `${k}: ${headers.get(k)}`)
          .join("\r\n");
      }
      
      // 替代方法2: 如果是普通对象
      if (typeof headers === 'object') {
        return Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
      }
      
      console.error("无法转换headers为字符串");
      return "Host: unknown";
    } catch (e2) {
      console.error("所有转换headers的方法都失败", e2);
      return "Host: unknown";
    }
  }
}

// 获取Gemini API模型列表
async function getGeminiModels(request, config) {
  try {
    console.log("开始获取Gemini模型列表...");
    
    // 获取Gemini API密钥
    const apiKey = getGeminiApiKey(request, config);
    console.log(`Gemini API密钥存在: ${!!apiKey}`);
    
    if (!apiKey) {
      console.log("没有找到有效的Gemini API密钥，返回空列表");
      return { object: "list", data: [] };
    }
    
    // 尝试从Gemini API实时获取模型列表
    try {
      console.log("尝试从Gemini API实时获取模型列表...");
      
      // 构建Gemini模型列表请求
      const baseUrl = config.geminiUpstreamUrl || "https://generativelanguage.googleapis.com";
      
      // 注意：我们不再将API密钥作为URL参数，而是放在请求头中
      const modelsUrl = `${baseUrl}/v1beta/models`;
      
      console.log(`发送请求到: ${modelsUrl}`);
      
      // 发送请求获取模型列表
      let modelsResponse;
      try {
        // 尝试使用标准fetch，将API密钥放在请求头中
        modelsResponse = await fetch(modelsUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey  // 正确的请求头格式
          }
        });
      } catch (fetchError) {
        console.error("标准fetch失败，尝试使用nativeFetch:", fetchError);
        // 如果标准fetch失败，使用nativeFetch
        const request = {
          method: "GET",
          headers: new Headers({
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey  // 正确的请求头格式
          }),
          url: modelsUrl
        };
        modelsResponse = await nativeFetch(request, modelsUrl);
      }
      
      console.log(`模型列表响应状态: ${modelsResponse.status}`);
      
      // 处理响应
      if (modelsResponse.ok) {
        const responseData = await modelsResponse.json();
        
        // 检查是否有模型数据
        if (responseData && responseData.models && Array.isArray(responseData.models)) {
          console.log(`成功获取到 ${responseData.models.length} 个Gemini模型`);
          
          // 将Gemini API模型格式转换为标准OpenAI格式 (只保留必要字段)
          const geminiModels = responseData.models.map(model => ({
            id: model.name.replace('models/', ''),
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "google"
            // 移除额外字段以符合OpenAI格式标准
          }));
          
          console.log(`返回 ${geminiModels.length} 个实时获取的Gemini模型`);
          
          return {
            object: "list",
            data: geminiModels
          };
        }
      } else {
        // 请求失败，记录错误
        console.error(`获取Gemini模型列表失败: ${modelsResponse.status}`);
        try {
          const errorData = await modelsResponse.text();
          console.error(`错误详情: ${errorData.substring(0, 200)}`);
        } catch (e) {
          console.error(`无法读取错误详情: ${e.message}`);
        }
      }
    } catch (apiError) {
      console.error("从Gemini API获取模型列表失败:", apiError);
    }
    
    // 如果实时获取失败，回退到预定义列表
    console.log("回退到预定义的Gemini模型列表");
    
    // 预定义的Gemini模型列表 (符合标准OpenAI格式)
    const geminiModels = [
      {
        id: "gemini-2.0-flash",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google"
      },
      {
        id: "gemini-2.0-pro-exp",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google"
      },
      {
        id: "gemini-2.0-flash-lite",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google"
      },
      {
        id: "gemini-2.0-flash-thinking-exp",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google"
      },
      {
        id: "gemini-1.5-pro",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google"
      },
      {
        id: "gemini-1.5-flash",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google"
      },
      {
        id: "gemini-1.5-flash-8b",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google"
      }
    ];
    
    console.log(`返回 ${geminiModels.length} 个预定义的Gemini模型`);
    
    return {
      object: "list",
      data: geminiModels
    };
  } catch (error) {
    console.error("获取Gemini模型列表时出错:", error);
    return { object: "list", data: [] };
  }
}

// 获取Anthropic API模型列表
async function getAnthropicModels(request, config) {
  try {
    console.log("开始获取Anthropic模型列表...");
    
    // 获取Anthropic API密钥
    const apiKey = getAnthropicApiKey(request, config);
    console.log(`Anthropic API密钥存在: ${!!apiKey}`);
    
    if (!apiKey) {
      console.log("没有找到有效的Anthropic API密钥，返回空列表");
      return { object: "list", data: [] };
    }
    
    // 尝试从Anthropic API实时获取模型列表
    try {
      console.log("尝试从Anthropic API实时获取模型列表...");
      
      // 构建Anthropic模型列表请求
      const baseUrl = config.anthropicUpstreamUrl || "https://api.anthropic.com";
      const url = `${baseUrl}/v1/models`;
      
      console.log(`发送请求到: ${url}`);
      
      // 发送请求获取模型列表
      let modelsResponse;
      try {
        // 尝试使用标准fetch
        modelsResponse = await fetch(url, {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          }
        });
      } catch (fetchError) {
        console.error("标准fetch失败，尝试使用nativeFetch:", fetchError);
        // 如果标准fetch失败，使用nativeFetch
        const request = {
          method: "GET",
          headers: new Headers({
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          }),
          url: url
        };
        modelsResponse = await nativeFetch(request, url);
      }
      
      console.log(`模型列表响应状态: ${modelsResponse.status}`);
      
      // 处理响应
      if (modelsResponse.ok) {
        const responseData = await modelsResponse.json();
        
        // 检查是否有模型数据
        if (responseData && responseData.models && Array.isArray(responseData.models)) {
          console.log(`成功获取到 ${responseData.models.length} 个Anthropic模型`);
          
          // 将Anthropic API模型格式转换为标准OpenAI格式 (只保留必要字段)
          const anthropicModels = responseData.models.map(model => ({
            id: model.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "anthropic"
            // 移除额外字段以符合OpenAI格式标准
          }));
          
          console.log(`返回 ${anthropicModels.length} 个实时获取的Anthropic模型`);
          
          return {
            object: "list",
            data: anthropicModels
          };
        }
      } else {
        // 请求失败，记录错误
        console.error(`获取Anthropic模型列表失败: ${modelsResponse.status}`);
        try {
          const errorData = await modelsResponse.text();
          console.error(`错误详情: ${errorData.substring(0, 200)}`);
        } catch (e) {
          console.error(`无法读取错误详情: ${e.message}`);
        }
      }
    } catch (apiError) {
      console.error("从Anthropic API获取模型列表失败:", apiError);
    }
    
    // 如果实时获取失败，回退到预定义列表
    console.log("回退到预定义的Anthropic模型列表");
    
    // 预定义的Anthropic模型列表 (符合标准OpenAI格式)
    const anthropicModels = [
      {
        id: "claude-3-7-sonnet-20250219",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic"
      },
      {
        id: "claude-3-5-sonnet-20241022",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic"
      },
      {
        id: "claude-3-5-haiku-20241022",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic"
      },
      {
        id: "claude-3-5-sonnet-20240620",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic"
      },
      {
        id: "claude-3-opus-20240229",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic"
      },
      {
        id: "claude-3-sonnet-20240229",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic"
      },
      {
        id: "claude-3-haiku-20240307",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic"
      }
    ];
    
    console.log(`返回 ${anthropicModels.length} 个预定义的Anthropic模型`);
    
    return {
      object: "list",
      data: anthropicModels
    };
  } catch (error) {
    console.error("获取Anthropic模型列表时出错:", error);
    return { object: "list", data: [] };
  }
}
