# LLM Stream Optimizer

Based on Cloudflare Workers!

变量：
`PROXY_API_KEY`=代理APIKEY，同时也是Web管理页的登录密码（可设置多个，以英文逗号分隔）

KV：创建新的KV，绑定名为`CONFIG_KV`



功能：

**API多合一**
- 支持添加OpenAI、Anthropic、Google Gemini格式的API

**智能流式输出优化**
- 将大型响应块分解为逐字符输出
- 基于响应块大小和时间间隔智能调整字符间延迟

**自适应延迟算法**
- 检测响应数据块大小：块越大，字符延迟越小
- 监控响应时间间隔：间隔越长，字符延迟越大
- 确保输出平滑自然，没有明显停顿

**Web API管理页面**
- 支持通过Web管理页面调整API设置
- 访问workers域名根目录即为Web管理页面
- Web管理页面登录密码为变量`PROXY_API_KEY`

**支持`/v1/models`路径获取模型列表**

**使用模型时一定要设置`max_tokens`，否则可能产生奇怪的截断情况！！！**

**使用模型时一定要设置`max_tokens`，否则可能产生奇怪的截断情况！！！**

**使用模型时一定要设置`max_tokens`，否则可能产生奇怪的截断情况！！！**

> Todo List:
> 支持同类型多API端点接入
> 集成ShadowFetch
