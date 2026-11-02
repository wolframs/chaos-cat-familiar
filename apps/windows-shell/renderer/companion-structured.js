/** Group presentation only; entries retain their original identities and content. */
export function groupConsecutiveSystemMessages(messages){
  const groups=[];
  for(const message of messages){
    const previous=groups.at(-1);
    if(message.role==='system'&&previous?.kind==='system-group')previous.messages.push(message);
    else groups.push({kind:message.role==='system'?'system-group':'message',id:message.role==='system'?`system-group:${message.id}`:message.id,messages:[message]});
  }
  return groups;
}

const ERROR_TITLES={'missing-auth':'Authentication required','model-unavailable':'Selected model unavailable',disconnected:'Connection lost','initialization-failed':'Could not connect'};

/** Text-only renderer for the Codex conversation. No model-provided markup or navigation is evaluated. */
export function createStructuredConversation({container,requests,jump,action,onError}) {
  const rows=new Map(),systemGroups=new Map(),forms=new Map();
  let latest=null,identity='',unread=0,historical=null,errorCard=null,errorKey='';
  const element=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const button=(label,callback)=>{const node=element('button','button',label);node.type='button';node.addEventListener('click',callback);return node;};
  jump.addEventListener('click',()=>{historical=null;if(latest)render(latest);container.scrollTop=container.scrollHeight;unread=0;jump.hidden=true;});

  function toolRow(message,row){
    const details=element('details','tool-details'),summary=element('summary','','Tool output');
    row.details=details;row.summary=summary;
    // Snapshots carry a short summary; the full retained output is fetched when opened.
    row.load=async()=>{
      if(row.output&&row.output.revision>=row.revision)return row.output;
      const response=row.previewAvailable?await action({action:'read-output',itemId:message.id}):{output:{itemId:message.id,text:row.text,revision:row.revision,outputLimited:row.outputLimited}};
      const output=response.output??response;
      if(typeof output.text!=='string')throw new Error('The retained output preview is unavailable.');
      if(rows.get(message.id)===row&&details.open){row.output=output;row.content.textContent=output.text+(output.outputLimited?'\n[Retained output preview limit reached]':'');}
      return output;
    };
    const show=()=>{row.content.textContent='Loading retained output…';row.load().catch(error=>{if(details.open)row.content.textContent=String(error.message??error);});};
    details.addEventListener('toggle',()=>{if(details.open)show();else{row.output=null;row.content.textContent='';}});
    row.refresh=()=>{if(details.open&&(!row.output||row.output.revision<row.revision))show();};
    const copy=button('Copy preview',()=>{row.load().then(output=>navigator.clipboard.writeText(output.text)).catch(onError);});
    details.append(summary,row.content,copy);row.root.append(row.label,details);
  }

  function renderMessages(messages){
    let changed=false;
    const retained=new Set(messages.map(item=>item.id));
    for(const [id,row]of rows)if(!retained.has(id)){row.root.remove();rows.delete(id);changed=true;}
    const groups=groupConsecutiveSystemMessages(messages),retainedGroups=new Set();
    for(const [position,group]of groups.entries()){
      let parent=container;
      if(group.kind==='system-group'){
        retainedGroups.add(group.id);let box=systemGroups.get(group.id);
        if(!box){const root=element('section','message system-group'),body=element('div','system-group-entries');root.append(element('div','system-group-label','SYSTEM'),body);box={root,body};systemGroups.set(group.id,box);}
        if(container.children[position]!==box.root){container.insertBefore(box.root,container.children[position]??null);changed=true;}
        parent=box.body;
      }
      for(const [entryPosition,message]of group.messages.entries()){
        let row=rows.get(message.id);
        if(!row){
          const root=element('article',message.role==='system'?'system-entry':`message message-${message.role}`);root.dataset.itemId=message.id;
          row={root,label:element('div','message-label'),content:element('pre','message-content'),text:null};
          if(message.role==='tool')toolRow(message,row);else root.append(row.label,row.content);
          rows.set(message.id,row);changed=true;
        }
        const rowPosition=parent===container?position:entryPosition;
        if(parent.children[rowPosition]!==row.root){parent.insertBefore(row.root,parent.children[rowPosition]??null);changed=true;}
        const label=[message.role==='assistant'?'CCF':message.role==='system'?'':message.role,message.status,message.timestamp?new Date(message.timestamp).toLocaleTimeString():''].filter(Boolean).join(' · ');
        if(row.label.textContent!==label)row.label.textContent=label;
        row.label.hidden=!label;
        const text=message.text.slice(0,65536);
        if(row.text!==text){row.text=text;if(!row.details)row.content.textContent=text+(message.outputLimited?'\n[Output preview limit reached]':'');changed=true;}
        if(row.details){
          row.revision=message.outputRevision;row.previewAvailable=message.outputPreviewAvailable;row.outputLimited=message.outputLimited;
          row.summary.textContent=`Tool output · ${text.split('\n',1)[0].slice(0,160)}`;row.refresh();
        }
        row.root.dataset.status=message.status??'';
      }
    }
    for(const [id,box]of systemGroups)if(!retainedGroups.has(id)){box.root.remove();systemGroups.delete(id);}
    return changed;
  }

  function renderError(snapshot){
    const nextKey=JSON.stringify(snapshot.errorInfo??null);
    if(nextKey===errorKey)return;
    errorCard?.remove();errorCard=null;errorKey=nextKey;
    const info=snapshot.errorInfo;if(!info)return;
    errorCard=element('section','request-card backend-error');errorCard.setAttribute('aria-label','Codex connection recovery');
    errorCard.append(element('h2','request-title',ERROR_TITLES[info.code]??'Codex needs attention'),element('p','',info.reason));
    const controls=element('div','request-actions');
    const canRecover=!snapshot.connected&&!snapshot.conversationId;
    for(const recovery of new Set([...(info.actions??[]),...(canRecover?['recover-launch']:[])])){
      if(recovery==='recover-launch'&&!canRecover)continue;
      if(recovery==='recover-launch')errorCard.append(element('p','','The previous launch may already have created a thread. This keeps its unknown context and releases its reservation; a later Start may create another thread.'));
      const label={'open-settings':'Open companion settings','recover-launch':'Retain unknown launch and allow a fresh thread',start:'Retry connection'}[recovery];
      if(!label)continue;
      const control=button(label,()=>{control.disabled=true;action({action:recovery,...(recovery==='recover-launch'?{retainUnknown:true}:{})}).catch(onError).finally(()=>{control.disabled=false;});});
      control.disabled=recovery==='start'&&snapshot.connected;controls.append(control);
    }
    errorCard.append(controls);requests.prepend(errorCard);
  }

  function requestCard(request,snapshot){
    const form=element('section','request-card');
    const params=request.params??{};
    const kind=request.method.includes('/fileChange/')?'File change approval':request.method.includes('/permissions/')?'Additional permissions':request.method.includes('/requestUserInput')?'Question':params.networkApprovalContext?'Network command approval':'Command approval';
    form.append(element('h2','request-title',request.supported?kind:'Unsupported request'),element('p','request-scope',`Codex · ${request.conversationId} · ${request.method.includes('/permissions/')?'this turn':'once'} · ${request.method}`));
    form.append(element('pre','request-detail',String(params.command??params.reason??request.method).slice(0,65536)));
    if(request.method==='item/fileChange/requestApproval'){
      const item=snapshot.messages.find(message=>message.id===request.itemId);
      form.append(element('pre','request-detail',request.detailsText??item?.text??`File change item ${request.itemId}; details unavailable. Interrupt to inspect before deciding.`));
    }
    if(params.cwd)form.append(element('p','request-scope',`Working directory: ${params.cwd}`));
    if(params.networkApprovalContext)form.append(element('pre','request-detail',JSON.stringify(params.networkApprovalContext,null,2)));
    const controls=element('div','request-actions');
    const run=async payload=>{
      if(!latest.pendingRequests.some(current=>current.key===request.key))return;
      for(const node of controls.querySelectorAll('button'))node.disabled=true;
      try{await action(payload);}catch(error){onError(error);for(const node of controls.querySelectorAll('button'))node.disabled=false;}
    };
    const resolve=response=>void run({action:'resolve-request',key:request.key,response});
    if(request.supported)for(const decision of request.decisions??[]){
      const labels={accept:kind==='File change approval'?'Allow these file changes once':'Allow this command once',decline:'Decline request',cancel:'Cancel and interrupt turn'};
      controls.append(button(labels[decision]??decision,()=>resolve({decision})));
    }
    if(request.supported&&request.method==='item/permissions/requestApproval'){
      form.append(element('pre','request-detail',JSON.stringify(params.permissions??{},null,2)));
      const grants=[];
      for(const [category,values]of Object.entries(params.permissions??{})){
        if(!values)continue;
        for(const [field,value]of Object.entries(values)){
          if(value==null)continue;
          for(const grant of Array.isArray(value)?value:[value]){
            const label=element('label','permission-choice'),input=document.createElement('input');input.type='checkbox';
            label.append(input,document.createTextNode(`${category}.${field}: ${JSON.stringify(grant)}`));form.append(label);
            grants.push({input,category,field,value:grant,array:Array.isArray(value)});
          }
        }
      }
      controls.append(button('Grant selected permissions for this turn',()=>{
        const permissions={};
        for(const grant of grants.filter(grant=>grant.input.checked)){
          permissions[grant.category]??={};
          if(grant.array)(permissions[grant.category][grant.field]??=[]).push(grant.value);
          else permissions[grant.category][grant.field]=grant.value;
        }
        resolve({permissions,scope:'turn'});
      }),button('Grant no additional permissions',()=>resolve({permissions:{},scope:'turn'})));
    }
    if(request.supported&&request.method==='item/tool/requestUserInput'){
      const inputs=[];
      for(const question of params.questions??[]){
        const label=element('label','question-field',question.question),input=document.createElement(question.options?.length&&!question.isOther?'select':'input');
        if(input.tagName==='SELECT')for(const option of question.options){const entry=element('option','',`${option.label} — ${option.description??''}`);entry.value=option.label;input.append(entry);}
        else{input.type=question.isSecret?'password':'text';input.maxLength=4096;}
        input.setAttribute('aria-label',question.header||question.question);label.append(input);form.append(label);inputs.push({id:question.id,input});
      }
      controls.append(button('Submit answers',()=>resolve({answers:Object.fromEntries(inputs.map(({id,input})=>[id,{answers:[input.value]}]))})));
    }
    if(!request.supported)form.append(element('p','','This request cannot be answered here. Interrupt the turn or stop the owned backend.'));
    controls.append(button('Interrupt turn',()=>void run({action:'interrupt'})),button('Disconnect backend',()=>void run({action:'stop'})));
    form.append(controls);
    return form;
  }

  function render(snapshot){
    const nextIdentity=`${snapshot.backend}:${snapshot.conversationId}:${snapshot.connectionEpoch}`;
    if(nextIdentity!==identity){
      identity=nextIdentity;historical=null;rows.clear();systemGroups.clear();forms.clear();
      container.replaceChildren();requests.replaceChildren();errorCard=null;errorKey='';
    }
    const follows=container.scrollHeight-container.scrollTop-container.clientHeight<48;
    const anchor=[...container.querySelectorAll('[data-item-id]')].find(node=>node.getBoundingClientRect().bottom>=container.getBoundingClientRect().top);
    const anchorTop=anchor?.getBoundingClientRect().top;
    const messages=historical??snapshot.messages;
    const changed=renderMessages(messages);
    if(!messages.length&&!container.children.length)container.append(element('p','empty-conversation',snapshot.connected?'Ready for your message.':'Start the companion to begin.'));
    else if(messages.length)container.querySelector('.empty-conversation')?.remove();
    renderError(snapshot);
    const keys=new Set(snapshot.pendingRequests.map(request=>request.key));
    for(const [key,form]of forms)if(!keys.has(key)){form.remove();forms.delete(key);}
    for(const request of snapshot.pendingRequests)if(!forms.has(request.key)){const form=requestCard(request,snapshot);forms.set(request.key,form);requests.append(form);}
    requests.hidden=forms.size===0&&!errorCard;
    if(historical){jump.hidden=false;jump.textContent='Viewing older messages · Jump to latest';}
    else if(follows){container.scrollTop=container.scrollHeight;unread=0;jump.hidden=true;}
    else if(changed){
      if(anchor&&container.contains(anchor))container.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
      unread++;jump.textContent=`New output (${unread}) · Jump to latest`;jump.hidden=false;
    }
  }

  return {
    update(snapshot){latest=snapshot;render(snapshot);},
    showHistory(items){historical=items;if(latest)render(latest);container.scrollTop=0;},
    suspend(){latest=null;identity='';historical=null;rows.clear();systemGroups.clear();forms.clear();},
    dispose(){rows.clear();systemGroups.clear();forms.clear();}
  };
}
