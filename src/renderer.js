const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const specialRoles = new Set(["visual_analysis", "document_reader"]);
const roleCatalog = {
  default:{title:"通用探查",summary:"处理没有专用角色覆盖的只读检索和基础核验。",uses:["定位少量文件或配置","回答范围明确的代码问题","作为普通子代理的默认入口"]},
  quick_scan:{title:"快速扫描",summary:"快速定位文件、符号、配置和小段代码，强调速度与精确出处。",uses:["查找某个类或函数在哪里","确认配置项来自哪个文件","返回 file:line 位置"]},
  deep_research:{title:"深度研究",summary:"跨文件、跨目录深度检索，梳理调用链、模块关系和完整证据。",uses:["追踪一个功能横跨哪些模块","分析调用链和数据流","核对实现现状并汇总多处证据"]},
  visual_analysis:{title:"视觉分析",summary:"分析截图、界面状态、图片和视觉差异。",uses:["检查 UI 截图中的布局问题","比较改版前后的视觉差异","识别界面状态和可见错误"]},
  document_reader:{title:"文档与前端阅读",summary:"阅读 PDF、文档版式、网页界面和前端视觉实现。",uses:["核验 PDF 或文档排版","阅读复杂网页界面","检查前端视觉实现与设计稿"]},
  verifier:{title:"独立核验",summary:"独立复查关键事实、配置、代码结论和测试证据。",uses:["复核主代理的关键判断","确认配置是否真正生效","检查测试证据是否支持结论"]},
  architect:{title:"架构分析",summary:"分析模块边界、依赖、约束和方案取舍。",uses:["评估模块职责划分","分析依赖与耦合风险","比较多个实现方案的权衡"]},
};
const state = { workspace:null, models:[], agentDrafts:[], profiles:[], activeProfileId:"", selectedProfileId:"", dirty:false, backups:[], selectedBackup:null, remoteBackups:[], lastWsResult:null, roleEditor:null };

function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c])}
function showToast(message,type=""){const toast=$("#toast");toast.textContent=message;toast.className=`toast ${type}`.trim();clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.classList.add("hidden"),4200)}
function setStatus(message){$("#statusText").textContent=message}
function setDirty(value=true){state.dirty=value;$("#applyButton").disabled=!value;$("#applyButton").textContent=value?"应用更改 *":"应用更改";$("#pendingSummary").textContent=value?"存在尚未写入的配置更改":"没有待保存的更改";$("#pendingSummary").classList.toggle("dirty",value)}
function activeProfile(){return state.profiles.find(profile=>profile.id===state.activeProfileId)||state.profiles[0]}
function connectionRequest(overrides={}){const profile=activeProfile()||{};return{profileId:profile.id,providerId:profile.providerId,baseUrl:profile.baseUrl,apiKey:undefined,model:$("#mainModel").value,paths:state.workspace?.paths,...overrides}}
function editorConnectionRequest(){return connectionRequest({profileId:state.selectedProfileId,providerId:$("#profileProviderId").value.trim(),baseUrl:$("#baseUrl").value.trim(),apiKey:$("#apiKey").value.trim()||undefined})}
function modelOptions(selected){const ids=new Set(state.models.map(m=>m.id));if(selected)ids.add(selected);return[...ids].sort((a,b)=>a.localeCompare(b)).map(id=>`<option value="${escapeHtml(id)}" ${id===selected?"selected":""}>${escapeHtml(id)}${/image|imagine/i.test(id)?" · 图像模型":""}</option>`).join("")}
function renderHealth(ok,label){const h=$("#cpaHealth");h.className=`health ${ok?"ok":"error"}`;h.innerHTML=`<i></i>${escapeHtml(label)}`}

function renderMain(){
  const main=state.workspace.main,profile=activeProfile();$("#mainConfigPath").textContent=main.filePath;
  $("#activeProfileSelect").innerHTML=state.profiles.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===state.activeProfileId?"selected":""}>${escapeHtml(item.name)} · ${escapeHtml(item.providerId)}</option>`).join("");
  $("#mainModel").innerHTML=modelOptions(main.model);$("#mainProvider").value=profile?.providerId||main.provider;$("#mainEffort").value=main.reasoningEffort
}

function renderProfiles(){
  $("#profileCount").textContent=String(state.profiles.length);
  $("#profilesList").innerHTML=state.profiles.map(profile=>`<button class="profile-item ${profile.id===state.selectedProfileId?"active":""}" data-id="${escapeHtml(profile.id)}"><strong>${escapeHtml(profile.name)}</strong><code>${escapeHtml(profile.providerId)}</code><small>${escapeHtml(profile.baseUrl||"未配置地址")}${profile.id===state.activeProfileId?" · 当前":""}</small></button>`).join("");
  $$(".profile-item").forEach(item=>item.addEventListener("click",()=>selectProfile(item.dataset.id)));
  const profile=state.profiles.find(item=>item.id===state.selectedProfileId)||state.profiles[0];
  if(!profile)return;
  state.selectedProfileId=profile.id;$("#profileEditorTitle").textContent=profile.name||"线路详情";$("#profileName").value=profile.name||"";$("#profileProviderId").value=profile.providerId||"";$("#baseUrl").value=profile.baseUrl||"";$("#apiKey").value="";$("#apiKey").placeholder=profile.apiKeyPresent?"已安全保存，可留空":"输入 CPA API Key";$("#transportMode").value=profile.transportMode||"http";$("#importedProfileBadge").classList.toggle("hidden",!profile.imported);$("#deleteProfileButton").disabled=state.profiles.length<=1;
}

function selectProfile(id){state.selectedProfileId=id;renderProfiles()}

function renderWebdavSettings(){
  const webdav=state.workspace?.settings?.webdav||{};$("#webdavEnabled").checked=Boolean(webdav.enabled);$("#webdavUrl").value=webdav.url||"";$("#webdavUsername").value=webdav.username||"";$("#webdavRemotePath").value=webdav.remotePath||"CPA-Model-Switcher";$("#webdavPassword").value="";$("#webdavPassphrase").value="";$("#webdavPassword").placeholder=webdav.passwordPresent?"已安全保存，可留空":"输入 WebDAV 密码";$("#webdavPassphrase").placeholder=webdav.encryptionPassphrasePresent?"已安全保存，可留空":"至少 8 个字符";const configured=Boolean(webdav.url&&webdav.username&&webdav.passwordPresent&&webdav.encryptionPassphrasePresent);$("#webdavStatusBadge").textContent=configured?(webdav.enabled?"自动上传已启用":"已配置"):"未配置";$("#webdavStatusBadge").className=`badge ${configured?"blue":"gray"}`
}

function webdavSettingsRequest(){return{enabled:$("#webdavEnabled").checked,url:$("#webdavUrl").value.trim(),username:$("#webdavUsername").value.trim(),remotePath:$("#webdavRemotePath").value.trim()||"CPA-Model-Switcher",password:$("#webdavPassword").value||undefined,encryptionPassphrase:$("#webdavPassphrase").value||undefined}}

async function activateProfile(id){
  const profile=state.profiles.find(item=>item.id===id);if(!profile)return;
  state.activeProfileId=id;state.selectedProfileId=id;state.models=[];$("#mainProvider").value=profile.providerId;$("#transportStatus").textContent=`传输：${profile.transportMode==="websocket"?"WebSocket":profile.transportMode==="auto"?"自动检测":"HTTP 流式"}`;renderMain();renderProfiles();setDirty();
  try{const saved=await window.cpaSwitcher.saveSettings({profiles:state.profiles,activeProfileId:id,autoRestartCodex:false});state.profiles=saved.profiles;await refreshModels()}catch(error){showToast(error.message,"error")}
}
function createAgentDraft(agent){return{...agent,follow:agent.model===state.workspace.main.model&&agent.provider===state.workspace.main.provider,protected:specialRoles.has(agent.name),targetModel:agent.model,targetEffort:agent.reasoningEffort}}
function roleInfo(role){const id=typeof role==="string"?role:role.id||role.name;const known=roleCatalog[id];if(known)return known;const description=typeof role==="object"?role.description:"";return{title:"自定义角色",summary:description||"用户创建的专用子代理角色。",uses:["按职责说明执行专门的只读任务","使用独立的模型、推理强度和沙箱设置"]}}
function renderAgents(){
  const mainModel=$("#mainModel").value;
  $("#agentsBody").innerHTML=state.agentDrafts.map((a,i)=>{
    const effective=a.follow?mainModel:a.targetModel;
    const badge=a.protected?'<span class="badge violet">专用角色</span>':a.follow?'<span class="badge blue">跟随</span>':'<span class="badge gray">独立</span>';
    const efforts=["none","low","medium","high","xhigh","max","ultra"].map(v=>`<option ${a.targetEffort===v?"selected":""}>${v}</option>`).join("");
    const info=roleInfo(a);
    return `<tr data-index="${i}"><td class="role"><button class="role-link" type="button"><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(info.title)} · ${escapeHtml(info.summary)}</small></button></td><td><label class="mode"><input class="agent-follow" type="checkbox" ${a.follow?"checked":""}><span>${a.follow?"跟随":"独立"}</span></label></td><td><select class="agent-model" ${a.follow?"disabled":""}>${modelOptions(effective)}</select></td><td><select class="agent-effort">${efforts}</select></td><td>${badge}</td></tr>`
  }).join("");
  $$("#agentsBody tr").forEach(row=>{
    const draft=state.agentDrafts[Number(row.dataset.index)];
    row.querySelector(".role-link").addEventListener("click",()=>openRoleDetails(Number(row.dataset.index)));
    row.querySelector(".agent-follow").addEventListener("change",e=>{draft.follow=e.target.checked;if(draft.follow)draft.targetModel=$("#mainModel").value;setDirty();renderAgents()});
    row.querySelector(".agent-model").addEventListener("change",e=>{draft.targetModel=e.target.value;setDirty()});
    row.querySelector(".agent-effort").addEventListener("change",e=>{draft.targetEffort=e.target.value;setDirty()});
  });
}

function roleFilePreview(id){
  const directory=state.workspace?.paths?.agentsDirectory||"";
  return id?`${directory.replace(/[\\/]$/,"")}\\${id}.toml`:"保存后生成"
}

function renderRoleGuide(id,description=""){
  const info=roleInfo({id,description});
  const configured=description&&roleCatalog[id]?`<p><b>配置中的职责：</b>${escapeHtml(description)}</p>`:"";
  $("#roleGuide").innerHTML=`<strong>${escapeHtml(info.title)}</strong><p>${escapeHtml(info.summary)}</p>${configured}<ul>${info.uses.map(item=>`<li>${escapeHtml(item)}</li>`).join("")}</ul>`
}

function updateRolePreview(){
  const id=$("#roleId").value.trim();
  renderRoleGuide(id,$("#roleDescription").value.trim());
  if(state.roleEditor?.mode==="create")$("#roleFilePath").textContent=roleFilePreview(id)
}

function openNewRole(){
  const profile=activeProfile();
  state.roleEditor={mode:"create",index:null};
  $("#roleModalTitle").textContent="新增子代理角色";
  $("#roleModalSubtitle").textContent="创建独立角色文件，并自动注册到 Codex 主配置。";
  $("#roleId").readOnly=false;$("#roleId").value="";
  $("#roleDescription").value="";
  $("#roleProvider").value=profile?.providerId||state.workspace.main.provider;
  $("#roleModel").innerHTML=modelOptions($("#mainModel").value||state.workspace.main.model);
  $("#roleEffort").value="high";$("#roleSandbox").value="read-only";
  $("#roleFilePath").textContent="保存后生成";$("#saveRoleButton").textContent="创建角色";
  renderRoleGuide("","");$("#roleModal").classList.remove("hidden");$("#roleId").focus()
}

function openRoleDetails(index){
  const role=state.agentDrafts[index];if(!role)return;
  const info=roleInfo(role);state.roleEditor={mode:"update",index};
  $("#roleModalTitle").textContent=`${info.title} · ${role.name}`;
  $("#roleModalSubtitle").textContent="这里展示角色用途和实际运行配置；保存时会先自动备份。";
  $("#roleId").readOnly=true;$("#roleId").value=role.id||role.name;
  $("#roleDescription").value=role.description||"";
  $("#roleProvider").value=role.provider;
  $("#roleModel").innerHTML=modelOptions(role.targetModel||role.model);
  $("#roleEffort").value=role.targetEffort||role.reasoningEffort;
  $("#roleSandbox").value=role.sandboxMode||"read-only";
  $("#roleFilePath").textContent=role.filePath;$("#saveRoleButton").textContent="保存角色";
  renderRoleGuide(role.id||role.name,role.description||"");$("#roleModal").classList.remove("hidden")
}

function closeRoleModal(){$("#roleModal").classList.add("hidden");state.roleEditor=null}

async function saveRole(){
  const editor=state.roleEditor;if(!editor)return;
  const id=$("#roleId").value.trim(),description=$("#roleDescription").value.trim();
  if(!/^[a-z][a-z0-9_]*$/.test(id)){showToast("角色标识必须以小写字母开头，只能包含小写字母、数字和下划线。","error");return}
  if(!description){showToast("请填写角色职责说明。","error");return}
  if(state.dirty&&!confirm("当前子代理矩阵还有未应用的更改。单独保存角色后界面会重新加载，这些待应用更改会丢失。仍要继续吗？"))return;
  const existing=editor.mode==="update"?state.agentDrafts[editor.index]:null;
  const payload={paths:state.workspace.paths,role:{id,filePath:existing?.filePath,originalHash:existing?.hash,description,provider:$("#roleProvider").value.trim(),model:$("#roleModel").value,reasoningEffort:$("#roleEffort").value,sandboxMode:$("#roleSandbox").value}};
  const button=$("#saveRoleButton");button.disabled=true;setStatus(editor.mode==="create"?"正在创建角色……":"正在更新角色……");
  try{
    const result=editor.mode==="create"?await window.cpaSwitcher.createRole(payload):await window.cpaSwitcher.updateRole(payload);
    closeRoleModal();showToast(`${editor.mode==="create"?"角色已创建":"角色已更新"}，备份：${result.snapshot.id}`,"success");await loadWorkspace()
  }catch(error){showToast(error.message,"error");setStatus(`角色保存失败：${error.message}`)}finally{button.disabled=false}
}

async function refreshModels(silent=false){
  const button=$("#refreshModelsButton");button.disabled=true;if(!silent)setStatus("正在从 CPA 获取模型……");
  try{
    const result=await window.cpaSwitcher.listModels(connectionRequest());state.models=result.models;
    const selected=$("#mainModel").value||state.workspace.main.model;$("#mainModel").innerHTML=modelOptions(selected);renderAgents();
    renderHealth(true,`${result.models.length} 个模型 · ${result.elapsedMs} ms`);$("#httpMetric").textContent=`${result.elapsedMs} ms`;$("#httpMetric").className="ok";$("#httpDetail").textContent=`HTTP ${result.status} · ${result.models.length} 个模型`;setStatus(`CPA 模型已刷新，共 ${result.models.length} 个。`)
  }catch(error){renderHealth(false,"CPA 连接失败");if(!silent)showToast(error.message,"error");setStatus(`CPA 连接失败：${error.message}`)}finally{button.disabled=false}
}

async function loadWorkspace(){
  setStatus("正在读取 Codex 配置……");
  try{
    state.workspace=await window.cpaSwitcher.loadWorkspace();state.agentDrafts=state.workspace.agents.map(createAgentDraft);state.profiles=state.workspace.settings.profiles||[];state.activeProfileId=state.workspace.settings.activeProfileId||state.profiles[0]?.id||"";state.selectedProfileId=state.activeProfileId;
    $("#versionLabel").textContent=`v${state.workspace.version}`;const profile=activeProfile();$("#transportStatus").textContent=`传输：${profile?.transportMode==="websocket"?"WebSocket":profile?.transportMode==="auto"?"自动检测":"HTTP 流式"}`;$("#codexStatus").textContent=state.workspace.codex.running?`Codex：运行中${state.workspace.codex.pid?` · PID ${state.workspace.codex.pid}`:""}`:"Codex：未运行";
    renderMain();renderProfiles();renderWebdavSettings();renderAgents();setDirty(false);await Promise.all([refreshModels(true),refreshBackups()]);setStatus("配置已加载。")
  }catch(error){renderHealth(false,"配置加载失败");showToast(error.message,"error");setStatus(error.message)}
}

function gatherPayload(){
  const profile=activeProfile();const mode=profile?.transportMode||"http";
  const supportsWs=mode==="auto"?(state.lastWsResult?.ok??state.workspace.main.connection.supportsWebsockets):mode==="websocket";
  const provider=profile?.providerId||$("#mainProvider").value.trim()||"cpa_direct";
  return{paths:state.workspace.paths,main:{provider,model:$("#mainModel").value,reasoningEffort:$("#mainEffort").value},connection:{profileId:profile?.id,name:profile?.name,baseUrl:profile?.baseUrl,apiKey:undefined,supportsWebsockets:supportsWs,transportMode:mode},agents:state.agentDrafts.map(a=>({filePath:a.filePath,originalHash:a.hash,provider,model:a.follow?$("#mainModel").value:a.targetModel,reasoningEffort:a.targetEffort})),reason:`切换线路 ${profile?.name||provider}，主代理 -> ${$("#mainModel").value}`}
}

function changePreview(){
  const lines=[],newModel=$("#mainModel").value,main=state.workspace.main;
  if(newModel!==main.model)lines.push(`<div class="change-line"><b>主代理</b> ${escapeHtml(main.model)} → ${escapeHtml(newModel)}</div>`);
  if($("#mainEffort").value!==main.reasoningEffort)lines.push(`<div class="change-line"><b>主代理强度</b> ${escapeHtml(main.reasoningEffort)} → ${escapeHtml($("#mainEffort").value)}</div>`);
  for(const a of state.agentDrafts){const target=a.follow?newModel:a.targetModel;if(target!==a.model||a.targetEffort!==a.reasoningEffort)lines.push(`<div class="change-line"><b>${escapeHtml(a.name)}</b> ${escapeHtml(a.model)} → ${escapeHtml(target)} · ${escapeHtml(a.targetEffort)}</div>`)}
  return lines.length?lines.join(""):'<div class="muted">连接或传输配置将被更新。</div>'
}

async function applyChanges(restart=false){
  const saveButton=$("#confirmApplyButton"),restartButton=$("#confirmApplyRestartButton");saveButton.disabled=true;restartButton.disabled=true;setStatus("正在创建备份并写入配置……");
  try{
    const codexWasRunning=Boolean(state.workspace.codex.running);const result=await window.cpaSwitcher.applyConfiguration(gatherPayload());$("#confirmModal").classList.add("hidden");
    let message=result.webdav?.ok?`配置已保存，WebDAV 加密备份已上传：${result.webdav.fileName}`:result.webdav&&!result.webdav.ok?`配置已保存，但 WebDAV 上传失败：${result.webdav.error}`:`配置写入成功，备份：${result.snapshot.id}`;
    if(restart&&codexWasRunning){
      setStatus("配置已保存，正在重启 Codex……");
      try{const restarted=await window.cpaSwitcher.restartCodex();message=restarted.restarted?`${message}；Codex 已重启，请新建对话。`:`${message}；未检测到正在运行的 Codex，无需重启。`;showToast(message,restarted.restarted?"success":"")}
      catch(error){showToast(`${message}；但 Codex 自动重启失败：${error.message}`,"error");setStatus("配置已保存，但 Codex 自动重启失败。")}
    }else if(restart){showToast(`${message}；Codex 当前未运行，下次启动会读取新配置。`,"success")}
    else{showToast(`${message}；当前对话不会改变，如新对话仍使用旧模型请重启 Codex。`,result.webdav&&!result.webdav.ok?"error":"success")}
    await loadWorkspace()
  }
  catch(error){showToast(error.message,"error");setStatus(`写入失败：${error.message}`)}finally{saveButton.disabled=false;restartButton.disabled=false}
}

function logDiagnostic(message,type=""){
  const line=document.createElement("div");line.className=type?`log-${type}`:"";line.textContent=`${new Date().toLocaleTimeString("zh-CN",{hour12:false})}  ${message}`;$("#diagnosticLog").appendChild(line);$("#diagnosticLog").scrollTop=$("#diagnosticLog").scrollHeight
}
async function testHttp(){
  logDiagnostic("开始测试 CPA /models……");
  try{const r=await window.cpaSwitcher.testHttp(connectionRequest());$("#httpMetric").textContent=`${r.elapsedMs} ms`;$("#httpMetric").className="ok";$("#httpDetail").textContent=`HTTP ${r.status} · ${r.modelCount} 个模型`;logDiagnostic(`HTTP 成功：${r.status}，${r.elapsedMs} ms，${r.modelCount} 个模型。`,"ok");return true}
  catch(error){$("#httpMetric").textContent="失败";$("#httpMetric").className="error";$("#httpDetail").textContent=error.message;logDiagnostic(`HTTP 失败：${error.message}`,"error");return false}
}
async function testWebSocket(){
  logDiagnostic("开始 WebSocket 握手测试……");
  try{const r=await window.cpaSwitcher.testWebSocket(connectionRequest());state.lastWsResult=r;$("#wsMetric").textContent=r.ok?`${r.elapsedMs} ms`:"失败";$("#wsMetric").className=r.ok?"ok":"error";$("#wsDetail").textContent=r.ok?"握手成功":r.error;logDiagnostic(r.ok?`WebSocket 握手成功：${r.elapsedMs} ms。`:`WebSocket 握手失败：${r.error}`,r.ok?"ok":"error");return r.ok}
  catch(error){$("#wsMetric").textContent="失败";$("#wsMetric").className="error";$("#wsDetail").textContent=error.message;logDiagnostic(`WebSocket 失败：${error.message}`,"error");return false}
}
async function testCompact(){
  const model=$("#mainModel").value;logDiagnostic(`测试 /responses/compact，模型：${model}……`);
  try{const r=await window.cpaSwitcher.testCompact(connectionRequest());$("#compactMetric").textContent=r.ok?`${r.elapsedMs} ms`:`HTTP ${r.status}`;$("#compactMetric").className=r.ok?"ok":"error";$("#compactDetail").textContent=r.ok?`模型 ${model}`:r.detail;logDiagnostic(r.ok?`压缩成功，明确使用 ${model}，耗时 ${r.elapsedMs} ms。`:`压缩失败：HTTP ${r.status}，${r.detail}`,r.ok?"ok":"error");return r.ok}
  catch(error){$("#compactMetric").textContent="失败";$("#compactMetric").className="error";$("#compactDetail").textContent=error.message;logDiagnostic(`压缩失败：${error.message}`,"error");return false}
}

async function refreshBackups(){
  state.backups=await window.cpaSwitcher.listBackups();$("#backupStatus").textContent=`备份：${state.backups.length}`;
  const list=$("#backupList");if(!state.backups.length){list.innerHTML='<div class="empty"><p>尚无自动备份</p></div>';return}
  list.innerHTML=state.backups.map((b,i)=>`<button class="backup-item" data-index="${i}"><strong>${escapeHtml(new Date(b.createdAt).toLocaleString("zh-CN"))}</strong><span>${escapeHtml(b.reason)} · ${b.files.length} 个文件</span></button>`).join("");
  $$(".backup-item").forEach(item=>item.addEventListener("click",()=>selectBackup(Number(item.dataset.index))))
}
function selectBackup(index){
  state.selectedBackup=state.backups[index];$$(".backup-item").forEach((item,i)=>item.classList.toggle("active",i===index));const b=state.selectedBackup;
  $("#backupDetail").className="backup-detail";$("#backupDetail").innerHTML=`<h3>${escapeHtml(new Date(b.createdAt).toLocaleString("zh-CN"))}</h3><p>${escapeHtml(b.reason)}</p><ul class="backup-files">${b.files.map(item=>`<li>${escapeHtml(item.originalPath)}</li>`).join("")}</ul><div class="settings-actions"><button id="restoreSelectedButton" class="btn">恢复此备份</button><button id="uploadSelectedButton" class="btn">上传到 WebDAV</button><button id="openBackupButton" class="btn ghost">打开备份位置</button></div>`;
  $("#restoreSelectedButton").addEventListener("click",restoreSelectedBackup);$("#uploadSelectedButton").addEventListener("click",()=>uploadWebdavBackup(b.directory));$("#openBackupButton").addEventListener("click",()=>window.cpaSwitcher.openPath(b.directory))
}
async function restoreSelectedBackup(){
  if(!state.selectedBackup||!confirm(`确定恢复 ${new Date(state.selectedBackup.createdAt).toLocaleString("zh-CN")} 的配置吗？恢复前会再次创建安全备份。`))return;
  try{await window.cpaSwitcher.restoreBackup(state.selectedBackup.directory);showToast("备份恢复成功。","success");await loadWorkspace()}catch(error){showToast(error.message,"error")}
}

async function saveWebdavSettings(){
  const settings=webdavSettingsRequest();if(!settings.url||!settings.username){showToast("请填写 WebDAV 地址和用户名。","error");return}
  const existing=state.workspace.settings.webdav||{};if(!settings.password&&!existing.passwordPresent){showToast("请填写 WebDAV 密码。","error");return}if(!settings.encryptionPassphrase&&!existing.encryptionPassphrasePresent){showToast("请设置至少 8 个字符的备份加密口令。","error");return}if(settings.encryptionPassphrase&&settings.encryptionPassphrase.length<8){showToast("备份加密口令至少需要 8 个字符。","error");return}
  try{const saved=await window.cpaSwitcher.saveSettings({profiles:state.profiles,activeProfileId:state.activeProfileId,autoRestartCodex:false,webdav:settings});state.workspace.settings.webdav=saved.webdav;renderWebdavSettings();showToast("WebDAV 设置已安全保存。","success")}catch(error){showToast(error.message,"error")}
}

async function testWebdav(){
  setStatus("正在测试 WebDAV……");
  try{const result=await window.cpaSwitcher.testWebDav(webdavSettingsRequest());showToast(`WebDAV 连接成功：HTTP ${result.status}，${result.elapsedMs} ms。`,"success");$("#webdavStatusBadge").textContent="连接正常";$("#webdavStatusBadge").className="badge blue";return true}catch(error){showToast(error.message,"error");$("#webdavStatusBadge").textContent="连接失败";$("#webdavStatusBadge").className="badge gray";return false}finally{setStatus("WebDAV 测试结束。")}
}

async function uploadWebdavBackup(snapshotDirectory){
  setStatus("正在加密并上传 WebDAV 备份……");
  try{const result=await window.cpaSwitcher.uploadWebDavBackup({snapshotDirectory,settings:webdavSettingsRequest()});showToast(`WebDAV 上传成功：${result.fileName}`,"success");await refreshRemoteBackups();return true}catch(error){showToast(error.message,"error");return false}finally{setStatus("WebDAV 上传结束。")}
}

async function refreshRemoteBackups(){
  const list=$("#remoteBackupList");list.className="remote-backups";list.innerHTML='<div class="muted">正在读取 WebDAV……</div>';
  try{state.remoteBackups=await window.cpaSwitcher.listWebDavBackups(webdavSettingsRequest());if(!state.remoteBackups.length){list.className="remote-backups empty";list.innerHTML="<p>远程目录中没有加密备份</p>";return}list.innerHTML=state.remoteBackups.map((item,index)=>`<div class="remote-backup-item"><div><strong>${escapeHtml(item.fileName)}</strong><small>加密 WebDAV 快照</small></div><button class="btn remote-restore" data-index="${index}">下载并恢复</button></div>`).join("");$$('.remote-restore').forEach(button=>button.addEventListener('click',()=>restoreRemoteBackup(Number(button.dataset.index))))}
  catch(error){list.className="remote-backups empty";list.innerHTML=`<p>${escapeHtml(error.message)}</p>`}
}

async function restoreRemoteBackup(index){
  const item=state.remoteBackups[index];if(!item||!confirm(`确定下载并恢复远程备份 ${item.fileName} 吗？当前配置会先创建安全快照。`))return;
  setStatus("正在下载、解密并恢复 WebDAV 备份……");
  try{await window.cpaSwitcher.restoreWebDavBackup({url:item.url,settings:webdavSettingsRequest()});showToast("WebDAV 远程备份恢复成功。","success");await loadWorkspace()}catch(error){showToast(error.message,"error")}finally{setStatus("远程恢复结束。")}
}

function nextProviderId(){
  let number=state.profiles.length+1;let value=`cpa_${number}`;const used=new Set(state.profiles.map(profile=>profile.providerId));while(used.has(value)){number+=1;value=`cpa_${number}`}return value
}

function addProfile(){
  const id=`profile-${Date.now()}`;state.profiles.push({id,name:`CPA 线路 ${state.profiles.length+1}`,providerId:nextProviderId(),baseUrl:"",transportMode:"http",apiKeyPresent:false,imported:false});state.selectedProfileId=id;renderProfiles();$("#profileName").focus()
}

async function saveSelectedProfile(){
  const profile=state.profiles.find(item=>item.id===state.selectedProfileId);if(!profile)return;
  const name=$("#profileName").value.trim(),providerId=$("#profileProviderId").value.trim(),baseUrl=$("#baseUrl").value.trim(),apiKey=$("#apiKey").value.trim(),transportMode=$("#transportMode").value;
  if(!name||!providerId||!baseUrl){showToast("请填写显示名称、提供方标识和 CPA 地址。","error");return}
  if(!/^[A-Za-z0-9_-]+$/.test(providerId)){showToast("提供方标识只能包含字母、数字、下划线和连字符。","error");return}
  if(state.profiles.some(item=>item.id!==profile.id&&item.providerId===providerId)){showToast(`提供方标识 ${providerId} 已被其他线路使用。`,"error");return}
  const updated={...profile,name,providerId,baseUrl,transportMode,...(apiKey?{apiKey}:{}),apiKeyPresent:Boolean(apiKey||profile.apiKeyPresent)};
  const profiles=state.profiles.map(item=>item.id===profile.id?updated:item);
  try{
    const saved=await window.cpaSwitcher.saveSettings({profiles,activeProfileId:state.activeProfileId,autoRestartCodex:false});state.profiles=saved.profiles;state.selectedProfileId=profile.id;
    if(profile.id===state.activeProfileId){$("#mainProvider").value=providerId;setDirty()}
    renderMain();renderProfiles();showToast("线路配置已安全保存。","success")
  }catch(error){showToast(error.message,"error")}
}

async function deleteSelectedProfile(){
  const profile=state.profiles.find(item=>item.id===state.selectedProfileId);if(!profile||state.profiles.length<=1)return;
  if(!confirm(`确定删除线路“${profile.name}”吗？这不会立即删除 Codex 中已有的 provider 区块。`))return;
  const profiles=state.profiles.filter(item=>item.id!==profile.id);const activeId=profile.id===state.activeProfileId?profiles[0].id:state.activeProfileId;
  try{const saved=await window.cpaSwitcher.saveSettings({profiles,activeProfileId:activeId,autoRestartCodex:false});state.profiles=saved.profiles;state.activeProfileId=activeId;state.selectedProfileId=activeId;const active=activeProfile();$("#mainProvider").value=active.providerId;renderMain();renderProfiles();setDirty();await refreshModels();showToast("线路已删除。","success")}catch(error){showToast(error.message,"error")}
}

function bindEvents(){
  $$(".nav").forEach(item=>item.addEventListener("click",()=>{$$(".nav").forEach(n=>n.classList.toggle("active",n===item));$$(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${item.dataset.page}`))}));
  $("#reloadButton").addEventListener("click",loadWorkspace);$("#refreshModelsButton").addEventListener("click",()=>refreshModels());
  $("#activeProfileSelect").addEventListener("change",event=>activateProfile(event.target.value));
  $("#mainModel").addEventListener("change",()=>{for(const a of state.agentDrafts)if(a.follow)a.targetModel=$("#mainModel").value;setDirty();renderAgents()});
  $("#mainEffort").addEventListener("change",()=>setDirty());
  $("#addAgentButton").addEventListener("click",openNewRole);
  $("#closeRoleButton").addEventListener("click",closeRoleModal);$("#cancelRoleButton").addEventListener("click",closeRoleModal);$("#saveRoleButton").addEventListener("click",saveRole);
  $("#roleId").addEventListener("input",updateRolePreview);$("#roleDescription").addEventListener("input",updateRolePreview);
  $("#roleModal").addEventListener("click",event=>{if(event.target===$("#roleModal"))closeRoleModal()});
  $("#followAllButton").addEventListener("click",()=>{const protect=$("#protectSpecial").checked;for(const a of state.agentDrafts){a.follow=!(protect&&specialRoles.has(a.name));if(a.follow)a.targetModel=$("#mainModel").value}setDirty();renderAgents()});
  $("#protectSpecial").addEventListener("change",()=>{const protect=$("#protectSpecial").checked;for(const a of state.agentDrafts)a.protected=protect&&specialRoles.has(a.name);renderAgents()});
  $("#applyButton").addEventListener("click",()=>{$("#changePreview").innerHTML=changePreview();$("#confirmModal").classList.remove("hidden")});
  $("#cancelApplyButton").addEventListener("click",()=>$("#confirmModal").classList.add("hidden"));$("#confirmApplyButton").addEventListener("click",()=>applyChanges(false));$("#confirmApplyRestartButton").addEventListener("click",()=>applyChanges(true));
  $("#toggleKeyButton").addEventListener("click",()=>{const input=$("#apiKey");input.type=input.type==="password"?"text":"password";$("#toggleKeyButton").textContent=input.type==="password"?"显示":"隐藏"});
  $("#addProfileButton").addEventListener("click",addProfile);$("#saveProfileButton").addEventListener("click",saveSelectedProfile);$("#deleteProfileButton").addEventListener("click",deleteSelectedProfile);
  $("#settingsTestButton").addEventListener("click",async()=>{logDiagnostic(`测试线路：${$("#profileName").value.trim()||"未命名线路"}`);try{const result=await window.cpaSwitcher.testHttp(editorConnectionRequest());showToast(`线路测试成功：${result.modelCount} 个模型，${result.elapsedMs} ms。`,"success")}catch(error){showToast(error.message,"error")}});$("#openConfigButton").addEventListener("click",()=>window.cpaSwitcher.openPath(state.workspace.paths.mainConfigPath));
  $("#saveWebdavButton").addEventListener("click",saveWebdavSettings);$("#testWebdavButton").addEventListener("click",testWebdav);$("#uploadLatestButton").addEventListener("click",()=>uploadWebdavBackup());$("#refreshRemoteBackupsButton").addEventListener("click",refreshRemoteBackups);
  $("#testHttpButton").addEventListener("click",testHttp);$("#testWsButton").addEventListener("click",testWebSocket);$("#testCompactButton").addEventListener("click",testCompact);
  $("#runAllDiagnostics").addEventListener("click",async()=>{$("#diagnosticLog").innerHTML="";const ok=await testHttp();if(ok)await testWebSocket();if(ok)await testCompact();logDiagnostic("诊断序列结束。","ok")});
  $("#refreshBackupsButton").addEventListener("click",refreshBackups);
  window.addEventListener("keydown",event=>{if(event.ctrlKey&&event.key.toLowerCase()==="s"){event.preventDefault();if(!$("#roleModal").classList.contains("hidden"))saveRole();else if(state.dirty)$("#applyButton").click()}if(event.ctrlKey&&event.key.toLowerCase()==="r"){event.preventDefault();refreshModels()}if(event.key==="Escape"){$("#confirmModal").classList.add("hidden");closeRoleModal()}})
}

bindEvents();
loadWorkspace();
