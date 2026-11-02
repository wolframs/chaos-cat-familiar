import {randomUUID} from 'node:crypto';

export const CODEX_OBSERVATION_EVENTS=Object.freeze(['SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PermissionRequest','PostToolUse','PreCompact','PostCompact','Stop','Interrupt','SubagentStart','SubagentStop']);
const STRINGS=['cwd','model','turn_id','tool_name','tool_use_id','permission_mode','source','reason','last_assistant_message','agent_id','agent_type'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Observation only. The Codex client remains the sole approval authority. */
export function adaptCodexHook(payload,{eventId=payload?.event_id??randomUUID()}={}){
  if(!object(payload))throw new Error('Codex hook payload must be an object');
  if(Buffer.byteLength(JSON.stringify(payload))>1024*1024)throw new Error('Codex hook input limit exceeded');
  if(!CODEX_OBSERVATION_EVENTS.includes(payload.hook_event_name))throw new Error('Unsupported Codex hook event');
  if(typeof payload.session_id!=='string'||!payload.session_id.trim()||payload.session_id.length>1024)throw new Error('A bounded Codex session identity is required');
  if(typeof eventId!=='string'||!eventId.trim()||eventId.length>256)throw new Error('A bounded Codex event identity is required');
  const result={backend:'codex',event_id:eventId,session_id:payload.session_id,hook_event_name:payload.hook_event_name,observation_only:true,integration_source:'codex-hook'};
  for(const field of STRINGS){if(payload[field]!=null){if(typeof payload[field]!=='string')throw new Error(`Invalid Codex hook ${field}`);result[field]=payload[field];}}
  for(const field of ['tool_input','tool_response']){
    if(payload[field]===undefined)continue;
    result[field]=payload[field]===null?null:object(payload[field])?structuredClone(payload[field]):{value:structuredClone(payload[field])};
  }
  if(payload.stop_hook_active!=null){if(typeof payload.stop_hook_active!=='boolean')throw new Error('Invalid Codex stop flag');result.stop_hook_active=payload.stop_hook_active;}
  return result;
}
