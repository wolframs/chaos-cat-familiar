export function mergeHostedCompanion(state,snapshot,cwd){
  if(snapshot?.backend!=='codex'||!snapshot.conversationId||!snapshot.connected)return state;
  const id=JSON.stringify(['codex',snapshot.conversationId]);
  const session={id,conversationId:snapshot.conversationId,sessionRootId:snapshot.sessionRootId??null,backend:'codex',assistantLabel:'Codex',status:'active',
    phase:snapshot.phase==='working'?'running':snapshot.phase==='attention'?'attention':'idle',projectDir:cwd,projectName:'Work companion',observationAuthority:'hosted',lastEventAt:new Date().toISOString(),activeSubagentCount:0};
  return{...state,sessions:[session,...(state.sessions??[]).filter(existing=>existing.id!==id)],hostedCompanion:{backend:'codex',conversationId:snapshot.conversationId,phase:snapshot.phase,
    pendingRequestCount:snapshot.pendingRequests?.length??0,error:snapshot.error??null,sessionId:id}};
}
