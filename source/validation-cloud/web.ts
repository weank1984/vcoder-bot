import { formatValidationArtifact } from "./presentation.js";

export const VALIDATION_CLOUD_WEB_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>VCoder 云端验证</title>
  <style>
    :root{color-scheme:light;--bg:#f4f4f0;--panel:#fff;--ink:#20211f;--muted:#6d7068;--line:#dcddd6;--accent:#275d45;--danger:#9f2d25}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(1040px,calc(100% - 32px));margin:32px auto 80px}header{display:flex;justify-content:space-between;gap:16px;align-items:end;margin-bottom:24px}
    h1,h2,p{margin-top:0}h1{font-size:26px;margin-bottom:4px}h2{font-size:18px}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.7fr);gap:18px}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:0 8px 28px rgba(30,34,28,.04)}label{display:block;font-weight:650;margin:14px 0 6px}
    input,textarea,button{font:inherit}input,textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:#fff;color:var(--ink)}textarea{min-height:100px;resize:vertical}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.actions{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}button{border:0;border-radius:9px;padding:10px 14px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}button.secondary{background:#e7e9e3;color:var(--ink)}button.danger{background:var(--danger)}button:disabled{opacity:.55;cursor:not-allowed}
    #auth{max-width:480px;margin:12vh auto}.task{border-top:1px solid var(--line);padding:14px 0;cursor:pointer}.task:first-child{border-top:0}.task-title{display:flex;justify-content:space-between;gap:12px;font-weight:700}.status{font-size:12px;border-radius:999px;background:#e7eee9;color:var(--accent);padding:3px 8px;white-space:nowrap}.status.failed,.status.interrupted{background:#f7e5e3;color:var(--danger)}
    pre{white-space:pre-wrap;word-break:break-word;background:#f5f6f2;border-radius:9px;padding:12px;font-size:12px}.hidden{display:none!important}.notice{border-left:4px solid var(--accent);padding:10px 12px;background:#edf3ef;border-radius:6px}.notice.danger{border-color:var(--danger);background:#f9ecea}.error{color:var(--danger)}
    .result-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.result-card{border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}.result-card h3{font-size:14px;margin:0 0 8px}.result-card pre{margin:0;max-height:260px;overflow:auto}.criteria{margin:8px 0 0;padding-left:20px}
    @media(max-width:760px){main{width:min(100% - 20px,1040px);margin-top:18px}.grid,.row,.result-grid{grid-template-columns:1fr}header{align-items:start;flex-direction:column}.panel{padding:16px}}
  </style>
</head>
<body>
<main>
  <section id="auth" class="panel">
    <h1>VCoder 云端验证</h1>
    <p class="muted">这是受控验证入口，不是生产服务。访问令牌只保存在当前浏览器标签页。</p>
    <label for="token">访问令牌</label><input id="token" type="password" autocomplete="off">
    <div class="actions"><button id="connect">进入工作台</button><span id="auth-error" class="error"></span></div>
  </section>

  <section id="workspace" class="hidden">
    <header><div><h1>异步工作验证台</h1><p class="muted">服务端接收后可以关闭页面；运行服务的主机必须保持在线。本机部署时请勿关闭或休眠本机。</p><p id="connection-state" class="muted" role="status"></p></div><button id="logout" class="secondary">退出</button></header>
    <div class="grid">
      <section class="panel">
        <h2>委派一个有限变更</h2>
        <form id="create-form">
          <label for="repo">HTTPS 仓库 URL</label><input id="repo" required placeholder="https://github.com/example/project.git">
          <div class="row"><div><label for="commit">完整 commit SHA</label><input id="commit" required minlength="40" maxlength="40"></div><div><label for="branch">分支（可选）</label><input id="branch"></div></div>
          <label for="goal">目标</label><textarea id="goal" required></textarea>
          <label for="criteria">验收条件（每行一项）</label><textarea id="criteria" required></textarea>
          <div class="row"><div><label for="minutes">最长分钟数</label><input id="minutes" type="number" min="1" max="30" value="30"></div><div><label for="turns">VCoder 最大轮次</label><input id="turns" type="number" min="1" max="16" value="16"></div></div>
          <div class="actions"><button id="submit" type="submit">提交到云端</button><span id="create-error" class="error"></span></div>
        </form>
        <div id="accepted" class="notice hidden"></div>
      </section>
      <aside class="panel"><h2>任务</h2><div id="tasks" class="muted">尚未加载</div></aside>
    </div>
    <section id="detail" class="panel hidden" style="margin-top:18px"></section>
  </section>
</main>
<script>
  let token = sessionStorage.getItem("validation-cloud-token") || "";
  let selectedTaskId = null;
  let detailVersion = "";
  let refreshInFlight = false;
  const formatArtifact = ${formatValidationArtifact.toString()};
  const el = id => document.getElementById(id);
  const statusCopy = {accepted:"已接收，可离开",preparing:"正在准备仓库",running:"正在执行",stopping:"正在安全停止",delivered:"已交付",failed:"失败，需要处理",cancelled:"已停止",interrupted:"服务中断"};
  const api = async (path, options={}) => {
    const headers = new Headers(options.headers || {}); headers.set("authorization", "Bearer " + token);
    if (options.body) headers.set("content-type", "application/json");
    const response = await fetch(path, {...options, headers});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || ("请求失败：" + response.status));
    return payload;
  };
  const showWorkspace = async () => {
    el("auth").classList.add("hidden"); el("workspace").classList.remove("hidden");
    try { await refreshTasks(); } catch (error) { logout(error.message); }
  };
  const logout = message => { token=""; sessionStorage.removeItem("validation-cloud-token"); selectedTaskId=null;detailVersion="";el("detail").replaceChildren();el("accepted").classList.add("hidden");el("token").value="";el("workspace").classList.add("hidden"); el("auth").classList.remove("hidden"); el("auth-error").textContent=message||""; };
  const renderTasks = tasks => {
    const root=el("tasks"); root.replaceChildren();
    if (!tasks.length) { root.textContent="还没有任务"; root.className="muted"; return; }
    root.className="";
    for (const task of tasks) { const item=document.createElement("div"); item.className="task"; const title=document.createElement("div"); title.className="task-title"; const goal=document.createElement("span"); goal.textContent=task.input.goal.slice(0,70); const status=document.createElement("span"); status.className="status "+task.status; status.textContent=statusCopy[task.status]||task.status; title.append(goal,status); const meta=document.createElement("div"); meta.className="muted"; meta.textContent=new Date(task.updatedAt).toLocaleString(); item.append(title,meta); item.onclick=()=>openTask(task.taskId); root.append(item); }
  };
  const refreshTasks = async () => { const data=await api("/api/tasks"); renderTasks(data.tasks); if (selectedTaskId) await openTask(selectedTaskId,false); el("connection-state").textContent="已连接 · 最近同步："+new Date().toLocaleTimeString(); };
  const artifactText = async artifact => { const response=await fetch("/api/artifacts/"+encodeURIComponent(artifact.artifactId)+"/download",{headers:{authorization:"Bearer "+token}}); if(!response.ok)throw new Error("读取交付物失败："+response.status); return await response.text(); };
  const resultCard = (title,text) => { const card=document.createElement("section"); card.className="result-card"; const heading=document.createElement("h3"); heading.textContent=title; const body=document.createElement("pre"); body.textContent=text; card.append(heading,body); return card; };
  const openTask = async (taskId,scroll=true) => {
    selectedTaskId=taskId; const data=await api("/api/tasks/"+encodeURIComponent(taskId)); if(selectedTaskId!==taskId)return; const task=data.task; const events=data.events; const runs=data.runs||[]; const artifacts=data.artifacts||[]; const version=taskId+":"+task.version+":"+events.length+":"+artifacts.length; if(!scroll&&detailVersion===version)return; detailVersion=version; const root=el("detail"); root.replaceChildren(); root.classList.remove("hidden");
    const heading=document.createElement("h2"); heading.textContent=task.input.goal; const status=document.createElement("p"); status.className="muted"; status.textContent="状态："+(statusCopy[task.status]||task.status)+" · 更新："+new Date(task.updatedAt).toLocaleString(); const repo=document.createElement("p"); repo.textContent=task.input.repository.url+" @ "+task.input.repository.commit; const limits=document.createElement("p"); limits.className="muted"; limits.textContent="上限："+task.input.limits.wallClockMinutes+" 分钟 / "+task.input.limits.maxTurns+" 轮"; const criteria=document.createElement("ul"); criteria.className="criteria"; for(const value of task.input.acceptanceCriteria){const item=document.createElement("li");item.textContent=value;criteria.append(item)} root.append(heading,status,repo,limits,criteria);
    const guidance=document.createElement("div"); guidance.className="notice"; if(task.status==="accepted"||task.status==="preparing"||task.status==="running"){guidance.textContent="任务记录已保存，可以关闭页面。运行服务的主机需保持在线；本机部署请勿关闭或休眠本机。"}else if(task.status==="stopping"){guidance.textContent="停止请求已保存，正在等待执行容器退出；已有部分结果会尽量保留。"}else if(task.status==="delivered"){guidance.textContent="任务已交付。先查看下方摘要和测试结论，再决定是否下载 patch 验收。"}else{guidance.classList.add("danger");guidance.textContent=task.status==="cancelled"?"任务已停止。若有部分结果，会显示在下方。":"任务未完成，请先看失败原因和已有部分结果，再决定是否创建新任务重试。"} root.append(guidance);
    if (["accepted","preparing","running","stopping"].includes(task.status)) { const stop=document.createElement("button"); stop.className="danger"; stop.textContent=task.status==="stopping"?"正在停止":"停止后续执行"; stop.disabled=task.status==="stopping"; stop.onclick=async()=>{ await api("/api/tasks/"+encodeURIComponent(taskId)+"/stop",{method:"POST"}); await refreshTasks(); }; root.append(stop); }
    if (task.terminalReason) { const reason=document.createElement("p"); reason.className="error"; reason.textContent=task.terminalReason; root.append(reason); }
    const previews=document.createElement("div"); previews.className="result-grid"; const previewKinds=[["summary","结果摘要"],["tests","测试结论"],["usage","用量与耗时"],["partial","已保留的部分结果"]]; for(const [kind,title] of previewKinds){const artifact=artifacts.find(value=>value.kind===kind);if(!artifact)continue;try{let text=await artifactText(artifact);if(kind==="tests"||kind==="usage"){try{const value=JSON.parse(text);text=formatArtifact(kind,value)}catch{}}previews.append(resultCard(title,text))}catch(error){previews.append(resultCard(title,"无法读取："+error.message))}} if(previews.childElementCount)root.append(previews);
    if (runs.length) { const runHeading=document.createElement("h2"); runHeading.style.marginTop="20px"; runHeading.textContent="执行尝试"; root.append(runHeading); for(const run of runs){const line=document.createElement("p"); line.textContent="#"+run.attempt+" · "+run.status+" · "+new Date(run.updatedAt).toLocaleString(); root.append(line);} }
    if (artifacts.length||events.length) { const artifactHeading=document.createElement("h2"); artifactHeading.style.marginTop="20px"; artifactHeading.textContent="交付物"; const actions=document.createElement("div"); actions.className="actions"; for(const artifact of artifacts){const button=document.createElement("button"); button.className="secondary"; button.textContent=artifact.kind+" · "+artifact.relativePath.split("/").pop(); button.onclick=async()=>{button.disabled=true;try{const response=await fetch("/api/artifacts/"+encodeURIComponent(artifact.artifactId)+"/download",{headers:{authorization:"Bearer "+token}});if(!response.ok)throw new Error("下载失败："+response.status);const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=artifact.relativePath.split("/").pop();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){alert(error.message)}finally{button.disabled=false}};actions.append(button)} const eventDownload=document.createElement("button");eventDownload.className="secondary";eventDownload.textContent="events · events.jsonl";eventDownload.onclick=async()=>{eventDownload.disabled=true;try{const response=await fetch("/api/tasks/"+encodeURIComponent(taskId)+"/events.jsonl",{headers:{authorization:"Bearer "+token}});if(!response.ok)throw new Error("下载失败："+response.status);const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=taskId+"-events.jsonl";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){alert(error.message)}finally{eventDownload.disabled=false}};actions.append(eventDownload);root.append(artifactHeading,actions); }
    const eventHeading=document.createElement("h2"); eventHeading.style.marginTop="20px"; eventHeading.textContent="事件"; const pre=document.createElement("pre"); pre.textContent=events.map(e=>e.sequence+"  "+e.occurredAt+"  "+e.type+"  "+JSON.stringify(e.payload)).join("\n"); root.append(eventHeading,pre); if(scroll) root.scrollIntoView({behavior:"smooth"});
  };
  el("connect").onclick=async()=>{ token=el("token").value.trim(); if(!token)return; sessionStorage.setItem("validation-cloud-token",token); try{await showWorkspace()}catch(error){logout(error.message)} };
  el("logout").onclick=()=>logout();
  el("create-form").onsubmit=async event=>{ event.preventDefault(); el("create-error").textContent=""; el("submit").disabled=true; try { const draft={repository:{url:el("repo").value,commit:el("commit").value,...(el("branch").value.trim()?{branch:el("branch").value}:{})},goal:el("goal").value,acceptanceCriteria:el("criteria").value.split("\n").map(v=>v.trim()).filter(Boolean),limits:{wallClockMinutes:Number(el("minutes").value),maxTurns:Number(el("turns").value)}}; let pending; try{pending=JSON.parse(sessionStorage.getItem("validation-pending-task")||"null")}catch{} if(!pending||JSON.stringify(pending.draft)!==JSON.stringify(draft)){pending={requestId:crypto.randomUUID(),draft};sessionStorage.setItem("validation-pending-task",JSON.stringify(pending))} const payload={requestId:pending.requestId,...draft}; const result=await api("/api/tasks",{method:"POST",body:JSON.stringify(payload)}); sessionStorage.removeItem("validation-pending-task"); el("accepted").textContent="服务端已接收，可以关闭页面。请保持运行服务的主机在线。任务 ID："+result.task.taskId; el("accepted").classList.remove("hidden"); selectedTaskId=result.task.taskId; await refreshTasks(); await openTask(result.task.taskId); } catch(error){el("create-error").textContent=error.message} finally{el("submit").disabled=false} };
  if(token) showWorkspace().catch(error=>logout(error.message));
  setInterval(async()=>{if(!token||refreshInFlight)return;refreshInFlight=true;try{await refreshTasks()}catch(error){el("connection-state").textContent="连接中断，正在重试；最后显示的状态可能已过期。"}finally{refreshInFlight=false}},3000);
</script>
</body>
</html>`;
