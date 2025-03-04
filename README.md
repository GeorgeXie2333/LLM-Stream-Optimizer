# ⚡LLM Stream Optimizer

Based on ☁️Cloudflare Workers!!!
<br>
**⚠️注意⚠️：本项目仍处在早期开发阶段，功能仍然不完善且可能有Bug，欢迎各位佬提issue/PR共同完善项目！！！**

<br><br><br>
🍗食用方法：


- 新建一个Cloudflare Workers
- 复制[worker.js](https://github.com/GeorgeXie2333/LLM-Stream-Optimizer/blob/main/worker.js)中的全部文本，粘贴到Workers编辑器中并部署
- Workers设置/变量和机密，添加一个类型为“密钥”，名为`PROXY_API_KEY`的变量，内容为代理后的APIKEY，同时也是Web管理页的登录密码
- Cloudflare左侧边栏/存储和数据库/KV，创建一个新的KV，名称随意。
- Workers设置/绑定/添加/KV 命名空间，变量名称设为`CONFIG_KV`，KV 命名空间选择刚刚创建的KV。
- 部署完成，打开你的Workers域名即可访问管理面板！




变量：

`PROXY_API_KEY`=代理APIKEY，同时也是Web管理页的登录密码<br>
`CONFIG_KV`=KV数据库，用于存储API数据及流式优化配置



**功能：**

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

**剔除 Cloudflare 自带 fetch 的多余请求头**
- 使用ShadowFetch替代Cloudflare Fetch
- 确保请求上游API时不会带有Cloudflare添加的其他请求头


**支持`/v1/models`路径获取模型列表**

> Todo List:
> 
> 支持同类型多API端点接入
> 
> 支持自定义API端点
