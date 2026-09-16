const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const specialRoles = new Set(["visual_analysis", "document_reader"]);
const state = { workspace:null, models:[], agentDrafts:[], profiles:[], activeProfileId:"", selectedProfileId:"", dirty:false, backups:[], selectedBackup:null, remoteBackups:[], lastWsResult:null };

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
function renderAgents(){
  const mainModel=$("#mainModel").value;
  $("#agentsBody").innerHTML=state.agentDrafts.map((a,i)=>{
    const effective=a.follow?mainModel:a.targetModel;
    const badge=a.protected?'<span class="badge violet">专用角色</span>':a.follow?'<span class="badge blue">跟随</span>':'<span class="badge gray">独立</span>';
    const efforts=["none","low","medium","high","xhigh","max","ultra"].map(v=>`<option ${a.targetEffort===v?"selected":""}>${v}</option>`).join("");
    return `<tr data-index="${i}"><td class="role"><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.fileName)}</small></td><td><label class="mode"><input class="agent-follow" type="checkbox" ${a.follow?"checked":""}><span>${a.follow?"跟随":"独立"}</span></label></td><td><select class="agent-model" ${a.follow?"disabled":""}>${modelOptions(effective)}</select></td><td><select class="agent-effort">${efforts}</select></td><td>${badge}</td></tr>`
  }).join("");
  $$("#agentsBody tr").forEach(row=>{
    const draft=state.agentDrafts[Number(row.dataset.index)];
    row.querySelector(".agent-follow").addEventListener("change",e=>{draft.follow=e.target.checked;if(draft.follow)draft.targetModel=$("#mainModel").value;setDirty();renderAgents()});
    row.querySelector(".agent-model").addEventListener("change",e=>{draft.targetModel=e.target.value;setDirty()});
    row.querySelector(".agent-effort").addEventListener("change",e=>{draft.targetEffort=e.target.value;setDirty()});
  });
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

async function applyChanges(){
  $("#confirmApplyButton").disabled=true;setStatus("正在创建备份并写入配置……");
  try{const result=await window.cpaSwitcher.applyConfiguration(gatherPayload());$("#confirmModal").classList.add("hidden");if(result.webdav?.ok)showToast(`配置已保存，WebDAV 加密备份已上传：${result.webdav.fileName}`,"success");else if(result.webdav&&!result.webdav.ok)showToast(`配置已保存，但 WebDAV 上传失败：${result.webdav.error}`,"error");else showToast(`配置写入成功，备份：${result.snapshot.id}`,"success");await loadWorkspace();if($("#confirmRestartHint").checked&&state.workspace.codex.running)showToast("Codex 正在运行；新任务会使用新配置，当前任务可能需要重新打开。")}
  catch(error){showToast(error.message,"error");setStatus(`写入失败：${error.message}`)}finally{$("#confirmApplyButton").disabled=false}
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
  $("#followAllButton").addEventListener("click",()=>{const protect=$("#protectSpecial").checked;for(const a of state.agentDrafts){a.follow=!(protect&&specialRoles.has(a.name));if(a.follow)a.targetModel=$("#mainModel").value}setDirty();renderAgents()});
  $("#protectSpecial").addEventListener("change",()=>{const protect=$("#protectSpecial").checked;for(const a of state.agentDrafts)a.protected=protect&&specialRoles.has(a.name);renderAgents()});
  $("#applyButton").addEventListener("click",()=>{$("#changePreview").innerHTML=changePreview();$("#confirmModal").classList.remove("hidden")});
  $("#cancelApplyButton").addEventListener("click",()=>$("#confirmModal").classList.add("hidden"));$("#confirmApplyButton").addEventListener("click",applyChanges);
  $("#toggleKeyButton").addEventListener("click",()=>{const input=$("#apiKey");input.type=input.type==="password"?"text":"password";$("#toggleKeyButton").textContent=input.type==="password"?"显示":"隐藏"});
  $("#addProfileButton").addEventListener("click",addProfile);$("#saveProfileButton").addEventListener("click",saveSelectedProfile);$("#deleteProfileButton").addEventListener("click",deleteSelectedProfile);
  $("#settingsTestButton").addEventListener("click",async()=>{logDiagnostic(`测试线路：${$("#profileName").value.trim()||"未命名线路"}`);try{const result=await window.cpaSwitcher.testHttp(editorConnectionRequest());showToast(`线路测试成功：${result.modelCount} 个模型，${result.elapsedMs} ms。`,"success")}catch(error){showToast(error.message,"error")}});$("#openConfigButton").addEventListener("click",()=>window.cpaSwitcher.openPath(state.workspace.paths.mainConfigPath));
  $("#saveWebdavButton").addEventListener("click",saveWebdavSettings);$("#testWebdavButton").addEventListener("click",testWebdav);$("#uploadLatestButton").addEventListener("click",()=>uploadWebdavBackup());$("#refreshRemoteBackupsButton").addEventListener("click",refreshRemoteBackups);
  $("#testHttpButton").addEventListener("click",testHttp);$("#testWsButton").addEventListener("click",testWebSocket);$("#testCompactButton").addEventListener("click",testCompact);
  $("#runAllDiagnostics").addEventListener("click",async()=>{$("#diagnosticLog").innerHTML="";const ok=await testHttp();if(ok)await testWebSocket();if(ok)await testCompact();logDiagnostic("诊断序列结束。","ok")});
  $("#refreshBackupsButton").addEventListener("click",refreshBackups);
  window.addEventListener("keydown",event=>{if(event.ctrlKey&&event.key.toLowerCase()==="s"){event.preventDefault();if(state.dirty)$("#applyButton").click()}if(event.ctrlKey&&event.key.toLowerCase()==="r"){event.preventDefault();refreshModels()}if(event.key==="Escape")$("#confirmModal").classList.add("hidden")})
}

bindEvents();
loadWorkspace();
