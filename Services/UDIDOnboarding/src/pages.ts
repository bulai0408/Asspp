import type { OnboardingRequest } from "./store";

const styles = `
  :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;background:#f5f6f7;color:#151719}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
  main{width:min(100%,440px);background:#fff;border:1px solid #d9dde1;border-radius:8px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.06)}
  h1{margin:0 0 8px;font-size:26px;letter-spacing:0}p{line-height:1.55;color:#505861}
  label{display:block;margin:24px 0 8px;font-size:15px;font-weight:600}
  input{width:100%;height:48px;border:1px solid #aeb5bc;border-radius:6px;padding:0 13px;font:inherit}
  button,.button{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:14px;border:0;border-radius:6px;background:#087e5b;color:#fff;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
  .alert{padding:12px;border-left:4px solid #c4322b;background:#fff0ef;color:#8d211d}.status{font-weight:700;color:#151719}
  .notice{padding:14px;border:1px solid #d59a22;background:#fff8e6;color:#5f4308;border-radius:6px;font-weight:700}
  .meta{font-size:13px;color:#737b83}noscript{color:#8d211d}
`;

function document(title: string, content: string): string {
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><main>${content}</main></body></html>`;
}

export function gatePage(error?: string): string {
  return document(
    "Asspp 设备配置",
    `<h1>Asspp 设备配置</h1>
     <p class="notice">需要联系 kami 配置 udid，配完后 可用 1 年</p>
     ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ""}
     <form method="post" action="/unlock">
       <label for="answer">作者的微信号 ID 是多少？</label>
       <input id="answer" name="answer" type="password" autocomplete="off" autocapitalize="none" required>
       <button type="submit">继续</button>
     </form>`,
  );
}

export function requestPage(request: OnboardingRequest): string {
  const statusLabel: Record<OnboardingRequest["state"], string> = {
    unlocked: "等待安装设备描述文件",
    device_received: "已收到设备信息，正在排队",
    building: "正在登记设备并重新签名",
    ready: "安装包已准备好",
    failed: "处理失败",
    expired: "本次请求已过期",
  };

  const action = request.state === "unlocked"
    ? `<a class="button" href="/requests/${encodeURIComponent(request.id)}/profile.mobileconfig">下载设备描述文件</a>`
    : request.state === "ready" && request.install_url
      ? `<a class="button" href="${escapeHtml(request.install_url)}">安装 Asspp</a><p class="meta">安装完成后，可在“设置”中移除临时的“Asspp 设备登记”描述文件。</p>`
      : request.state === "failed"
        ? `<p class="alert" role="alert">处理失败，请重新开始。错误代码：${escapeHtml(request.error_code ?? "UNKNOWN")}</p>`
        : "<p>页面会自动刷新状态。</p>";

  const pollScript = request.state === "device_received" || request.state === "building"
    ? `<script>setInterval(async()=>{const r=await fetch('/api/requests/${encodeURIComponent(request.id)}',{cache:'no-store'});if(r.ok){const s=await r.json();if(s.state==='ready'||s.state==='failed'||s.state==='expired')location.reload()}},3000)</script>`
    : "";

  return document(
    "Asspp 设备配置",
    `<h1>设备配置</h1><p class="status">${statusLabel[request.state]}</p>${action}<noscript>请手动刷新页面查看进度。</noscript>${pollScript}`,
  );
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
