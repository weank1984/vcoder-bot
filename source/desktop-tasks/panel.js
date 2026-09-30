import { formatValidationArtifact } from "../validation-cloud/presentation.ts";

// Loaded by the production renderer build, with all service access through the
// app-window-only preload bridge. No service credential is returned to this UI.
const agent = window.desktop?.agent;
if (agent?.backgroundTasks) install();

function install() {
  const api = request => agent.backgroundTasks({ ...request, ...(config?.url ? { serviceUrl: config.url } : {}) });
  const persistence = agent.clientPersistence;
  const host = document.createElement("div");
  host.id = "vbot-background-tasks";
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host{font:14px/1.5 system-ui;color-scheme:light dark}*{box-sizing:border-box}
    dialog{color:CanvasText;background:Canvas;border:1px solid GrayText;border-radius:16px;padding:24px;width:min(960px,94vw);max-height:90vh;overflow:auto}
    dialog::backdrop{background:#0007}h2,h3,p{margin:0 0 12px}h2{font-size:22px}h3{font-size:16px}
    button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid GrayText;border-radius:8px;padding:7px 12px;background:ButtonFace;color:ButtonText}button:disabled{opacity:.5;cursor:wait}
    input,textarea{width:100%;background:Field;color:FieldText;border:1px solid GrayText;border-radius:7px;padding:8px}textarea{min-height:85px;resize:vertical}label{display:block;margin:12px 0 4px}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.split{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:20px}.muted{opacity:.75;font-size:12px}.error{color:light-dark(#a12727,#ffaaaa)}
    .notice{border-left:3px solid #4b9574;padding:10px;margin:12px 0;background:light-dark(#f0f7f3,#1f3028)}.task{display:block;text-align:left;width:100%;margin:8px 0;overflow-wrap:anywhere}.task span{display:block;font-size:12px;opacity:.8}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:light-dark(#f3f4f2,#252823);border-radius:8px;max-height:280px;overflow:auto}#detail{margin-top:22px;border-top:1px solid GrayText;padding-top:18px}
    #launch{position:fixed;bottom:14px;left:14px;z-index:200;background:Canvas;color:CanvasText;box-shadow:0 2px 12px #0002}summary{cursor:pointer}fieldset{border:0;padding:0;margin:0;min-width:0}
    @media(max-width:700px){.split{grid-template-columns:1fr}dialog{padding:16px}}
  </style>
  <button id="launch" type="button">后台任务</button>
  <dialog aria-labelledby="title">
    <div class="row"><h2 id="title">后台任务</h2><button id="close" type="button" style="margin-left:auto">关闭</button></div>
    <p id="connection" role="status" class="muted">尚未连接</p>
    <p id="error" role="alert" class="error"></p>
    <details id="settings"><summary>服务连接</summary>
      <form id="config-form"><label>服务地址<input id="url" type="url" required placeholder="http://127.0.0.1:18791"></label>
      <label>服务访问令牌<input id="token" type="password" autocomplete="off" minlength="24" required></label>
      <p class="muted">填写任务服务的访问令牌。模型由服务端配置。</p><button type="submit">验证并连接</button><p id="storage" class="muted"></p></form>
    </details>
    <p id="departure" class="notice"></p>
    <div class="split">
      <section><h3>确认委派</h3><p class="muted">从对话输入区带入目标；本轮只发送下方确认的文字和仓库信息，附件与聊天历史不随任务上传。</p>
        <form id="task-form"><fieldset id="fields">
          <label>目标<textarea id="goal" required maxlength="20000"></textarea></label>
          <label>仓库 URL<input id="repo" type="url" required placeholder="https://github.com/owner/repo.git"></label>
          <label>完整 commit SHA<input id="commit" pattern="[a-fA-F0-9]{40}" required maxlength="40"></label>
          <label>验收条件（每行一项）<textarea id="criteria" required></textarea></label>
          <label>最长执行分钟数<input id="minutes" type="number" min="1" max="30" value="3" required></label>
          <p class="muted">允许在独立工作区修改文件；当前 runner 仅预授权 git diff --check，其他项目测试须另行验收。最多 16 轮。不会自动推送代码或创建 PR。</p>
          <button type="submit">确认并委派</button>
        </fieldset></form><p id="accepted" class="notice" hidden></p>
      </section>
      <section><div class="row"><h3>已委派任务</h3><button id="refresh" type="button">刷新</button></div><p class="muted">显示当前服务最近 100 项任务。</p><div id="tasks"></div></section>
    </div><section id="detail" hidden></section>
  </dialog>`;
  const el = id => shadow.getElementById(id);
  const dialog = shadow.querySelector("dialog");
  let config;
  let state = {};
  let selected = null;
  let busy = false;
  let detailVersion = "";
  let generation = 0;
  let saveQueue = Promise.resolve();
  let stateKey;
  const status = { accepted: "已接收", preparing: "准备仓库", running: "执行中", stopping: "正在停止", delivered: "已交付 · 待验收", failed: "执行失败", cancelled: "已停止", interrupted: "执行中断" };
  const fail = error => { el("error").textContent = error?.message || String(error); };
  const save = () => {
    const key = stateKey, json = JSON.stringify(state);
    const next = saveQueue.catch(() => {}).then(() => persistence.write(key, json));
    saveQueue = next;
    return next;
  };
  const draft = () => ({ repository: { url: el("repo").value.trim(), commit: el("commit").value.trim() }, goal: el("goal").value.trim(), acceptanceCriteria: el("criteria").value.split("\n").map(x => x.trim()).filter(Boolean), limits: { wallClockMinutes: Number(el("minutes").value), maxTurns: 16 } });
  const populate = value => {
    if (!value) return;
    el("repo").value = value.repository?.url || "";
    el("commit").value = value.repository?.commit || "";
    el("goal").value = value.goal || "";
    el("criteria").value = value.acceptanceCriteria?.join("\n") || "";
    el("minutes").value = value.limits?.wallClockMinutes || 3;
  };
  async function loadConfig() {
    config = await api({ action: "config" });
    stateKey = "vbot.background-tasks.v1." + encodeURIComponent(config.url);
    try { state = JSON.parse(await persistence.read(stateKey) || "{}"); } catch { state = {}; }
    selected = state.selected || null;
    populate(state.draft);
    el("url").value = config.url;
    el("settings").open = !config.configured;
    el("fields").disabled = !config.configured;
    el("storage").textContent = config.persistent ? "连接凭据由系统安全存储保存。" : "系统安全存储不可用，连接凭据仅在本次 App 运行期间保留。";
    el("departure").textContent = config.local ? "本机服务：可关闭任务面板；运行服务的电脑和 Docker 必须保持在线，不能关机或休眠。" : "任务由独立服务执行。确认接收后可以退出 App；服务主机需要保持在线。";
  }
  async function open(goal) {
    if (!dialog.open) dialog.showModal();
    try {
      await saveQueue;
      generation++;
      detailVersion = "";
      await loadConfig();
      if (goal) { el("goal").value = goal; state.draft = draft(); await save(); }
      if (config.configured) await refresh();
    } catch (error) { fail(error); }
  }
  el("launch").onclick = () => open();
  el("close").onclick = () => dialog.close();
  el("config-form").onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    el("error").textContent = "";
    try {
      await api({ action: "configure", url: el("url").value.trim(), token: el("token").value });
      el("token").value = "";
      generation++;
      detailVersion = "";
      el("detail").hidden = true;
      await loadConfig();
      el("settings").open = false;
      await refresh();
    } catch (error) { fail(error); } finally { button.disabled = false; }
  };
  el("task-form").oninput = () => { if (stateKey) { state.draft = draft(); save().catch(fail); } };
  el("task-form").onsubmit = async event => {
    event.preventDefault();
    el("fields").disabled = true;
    el("error").textContent = "";
    try {
      const input = draft();
      if (!state.pending || JSON.stringify(state.pending.input) !== JSON.stringify(input)) state.pending = { requestId: crypto.randomUUID(), input };
      state.draft = input;
      await save(); // Persist BEFORE submission so a restart/timeout can retry safely.
      const result = await api({ action: "submit", input: { ...input, requestId: state.pending.requestId } });
      selected = result.task.taskId;
      state.selected = selected;
      state.pending = null;
      await save();
      el("accepted").hidden = false;
      el("accepted").textContent = "已由服务接收：" + selected;
      await refresh();
    } catch (error) { fail(error); } finally { el("fields").disabled = false; }
  };
  async function refresh() {
    if (busy || !config?.configured) return;
    busy = true;
    const epoch = generation;
    try {
      const result = await api({ action: "list" });
      if (epoch !== generation) return;
      el("tasks").replaceChildren();
      for (const task of result.tasks) {
        const button = document.createElement("button");
        button.className = "task";
        button.textContent = task.input.goal.slice(0, 100);
        const meta = document.createElement("span");
        meta.textContent = `${status[task.status] || task.status} · ${new Date(task.updatedAt).toLocaleString()}`;
        button.append(meta);
        button.onclick = async () => { selected = task.taskId; state.selected = selected; detailVersion = ""; try { await save(); await detail(); } catch (error) { fail(error); } };
        el("tasks").append(button);
      }
      if (!result.tasks.length) el("tasks").textContent = "还没有后台任务";
      if (selected) await detail();
      el("connection").textContent = "已连接 · 最近同步 " + new Date().toLocaleTimeString();
    } catch (error) { el("connection").textContent = "连接中断；显示的状态可能已过期，稍后自动重试"; fail(error); }
    finally { busy = false; }
  }
  async function detail() {
    const taskId = selected, epoch = generation;
    const result = await api({ action: "detail", taskId });
    if (selected !== taskId || epoch !== generation) return;
    const version = `${taskId}:${result.task.version}:${result.artifacts.length}`;
    if (version === detailVersion) return;
    const content = document.createElement("div");
    const add = (tag, text) => { const node = document.createElement(tag); node.textContent = text; content.append(node); return node; };
    add("h3", result.task.input.goal);
    add("p", `${status[result.task.status] || result.task.status} · ${taskId}`);
    add("p", "输入：" + result.task.input.repository.url + " @ " + result.task.input.repository.commit).className = "muted";
    if (result.task.terminalReason) add("p", result.task.terminalReason).className = "error";
    if (result.task.status === "delivered") add("p", "交付物已保存。请核对目标是否达成、是否缺少信息，以及测试是否实际执行。交付状态不代表验收通过。").className = "notice";
    if (["accepted", "preparing", "running", "stopping"].includes(result.task.status)) {
      const stop = add("button", result.task.status === "stopping" ? "正在停止" : "停止后续执行");
      stop.disabled = result.task.status === "stopping";
      stop.onclick = async () => { stop.disabled = true; try { await api({ action: "stop", taskId }); detailVersion = ""; await refresh(); } catch (error) { fail(error); stop.disabled = false; } };
    }
    for (const artifact of result.artifacts) {
      if (["summary", "tests", "usage"].includes(artifact.kind)) {
        const data = await api({ action: "artifact", taskId, artifactId: artifact.artifactId });
        let text = data.text;
        if (artifact.kind !== "summary") { try { text = formatValidationArtifact(artifact.kind, JSON.parse(text)); } catch {} }
        add("h3", { summary: "结果与未验证事项", tests: "测试证据", usage: "用量与耗时" }[artifact.kind]);
        add("pre", text);
      }
      const download = add("button", "下载 " + artifact.relativePath.split("/").pop());
      download.onclick = async () => {
        download.disabled = true;
        try {
          const data = await api({ action: "artifact", taskId, artifactId: artifact.artifactId });
          const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
          const link = document.createElement("a"); link.href = url; link.download = data.filename; shadow.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { fail(error); } finally { download.disabled = false; }
      };
    }
    if (selected !== taskId || epoch !== generation) return;
    el("detail").replaceChildren(content); el("detail").hidden = false; detailVersion = version;
  }
  el("refresh").onclick = refresh;
  setInterval(() => { if (dialog.open) void refresh(); }, 4000);

  // The shipped 0.18 renderer and reconstructed composer share this class.
  // Read only the explicit draft; never intercept the existing send operation.
  const attach = () => {
    for (const row of document.querySelectorAll(".sand-prompt-actions-row")) {
      if (row.querySelector("[data-vbot-delegate]")) continue;
      const button = document.createElement("button");
      button.type = "button"; button.dataset.vbotDelegate = "true"; button.textContent = "委派后台任务";
      button.style.cssText = "font:12px system-ui;padding:5px 9px;border:1px solid #8886;border-radius:7px;background:transparent;color:inherit;cursor:pointer;margin-inline:8px";
      button.onclick = () => {
        const editor = row.closest("form")?.querySelector('[contenteditable="true"]') || row.parentElement?.querySelector('[contenteditable="true"]');
        void open(editor?.innerText?.trim());
      };
      row.append(button);
    }
  };
  let scheduled = false;
  new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; attach(); }); } }).observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
  attach();
}
