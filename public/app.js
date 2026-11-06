(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const view = $('#view');
  const modal = $('#modal');
  const modalContent = $('#modalContent');
  const state = { data: null, review: null, reviewFilter: 'all', filters: {q:'',status:'all',priority:'all',tag:'all'}, selectedPlan: '', noticeDismissed: false };

  const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  const localDateTime = (d = new Date()) => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d).replace(' ','T');
  const seoulDateTimeToUtc = value => new Date(`${value}:00+09:00`).toISOString();
  const fmtDate = d => d ? new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeZone:'Asia/Seoul'}).format(new Date(`${d}T00:00:00+09:00`)) : '마감일 없음';
  const mins = m => `${Number(m||0).toLocaleString('ko-KR')}분`;
  const priorityLabel = n => ({1:'낮음',2:'보통',3:'높음',4:'매우 높음',5:'최우선'})[Number(n)] || '보통';
  const statusLabel = s => s === 'done' ? '완료' : '진행 중';
  const currentHash = () => (location.hash || '#home').slice(1).split('?')[0];
  const planById = id => state.data.plans.find(p => p.id === id);
  const taskById = id => state.data.tasks.find(t => t.id === id);
  const tasksFor = planId => state.data.tasks.filter(t => t.plan_id === planId);

  async function api(path, options={}) {
    const response = await fetch(path, {headers:{'Content-Type':'application/json'}, ...options});
    const type = response.headers.get('content-type') || '';
    if (!response.ok) {
      const body = type.includes('json') ? await response.json() : {};
      throw new Error(body.error || `요청에 실패했습니다 (${response.status}).`);
    }
    return type.includes('json') ? response.json() : response;
  }
  async function refresh() {
    state.data = await api('/api/bootstrap');
    if (!state.selectedPlan || !planById(state.selectedPlan)) state.selectedPlan = state.data.plans[0]?.id || '';
    if (currentHash() === 'review') await loadReview();
    render();
  }
  async function loadReview() {
    const from = $('#reviewFrom')?.value || localDate(new Date(Date.now()-29*86400000));
    const to = $('#reviewTo')?.value || localDate();
    state.review = await api(`/api/review?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  }
  function toast(message, error=false) {
    const node=$('#toast'); node.textContent=message; node.classList.toggle('toast-error',error); node.hidden=false;
    clearTimeout(toast.timer); toast.timer=setTimeout(()=>node.hidden=true,3600);
  }
  function showError(error) { toast(error?.message || '처리 중 문제가 생겼습니다.', true); }
  function openModal(html) { modalContent.innerHTML=html; modal.showModal(); }
  function closeModal() { modal.close(); }
  function navActive(route) { document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===route)); }
  function shellHeading(kicker,title,description,action='') {
    return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
  }
  function render() {
    if (!state.data) return;
    const route=currentHash(); navActive(route);
    if (route === 'plans') renderPlans();
    else if (route === 'review') renderReview();
    else renderHome();
  }
  function taskCard(t, compact=false) {
    const tags=(t.tags||[]).map(tag=>`<span class="tag">${esc(tag)}</span>`).join('');
    const p=planById(t.plan_id);
    return `<article class="task-row ${t.status==='done'?'is-done':''}">
      <button class="check-button ${t.status==='done'?'checked':''}" type="button" data-action="toggle" data-id="${esc(t.id)}" aria-label="${t.status==='done'?'진행 중으로 되돌리기':'완료로 표시'}">${t.status==='done'?'✓':''}</button>
      <div class="task-main"><button class="task-title" type="button" data-action="task-detail" data-id="${esc(t.id)}">${esc(t.title)}</button>
        <div class="task-meta">${compact?`<span>${esc(p?.title||'계획 없음')}</span><span class="dot">·</span>`:''}<span>${esc(fmtDate(t.due_date))}</span><span class="dot">·</span><span>우선순위 ${esc(priorityLabel(t.priority))}</span><span class="dot">·</span><span>예상 ${esc(mins(t.estimated_minutes))}</span></div>
        ${tags?`<div class="tag-list">${tags}</div>`:''}</div>
      <div class="task-actions"><button class="icon-button" type="button" data-action="edit-task" data-id="${esc(t.id)}" aria-label="할 일 수정">편집</button><button class="icon-button danger-text" type="button" data-action="delete-task" data-id="${esc(t.id)}" aria-label="할 일 삭제">삭제</button></div>
    </article>`;
  }
  function planCard(p) {
    const count=tasksFor(p.id).length, done=tasksFor(p.id).filter(t=>t.status==='done').length;
    return `<button class="plan-card ${state.selectedPlan===p.id?'selected':''}" type="button" data-action="select-plan" data-id="${esc(p.id)}">
      <span class="plan-card-top"><span class="status-pill">${count?`${done}/${count} 완료`:'새 계획'}</span><span class="priority-dot priority-${p.priority}" title="우선순위 ${p.priority}"></span></span>
      <strong>${esc(p.title)}</strong><span class="plan-dates">${esc(fmtDate(p.start_date))} – ${esc(fmtDate(p.end_date))}</span>
      <span class="progress-track"><i style="width:${count?Math.round(done/count*100):0}%"></i></span></button>`;
  }
  function renderHome() {
    const today=state.data.today;
    const tasks=state.data.tasks;
    const completed=tasks.filter(t=>t.status==='done').length;
    const due=tasks.filter(t=>t.status!=='done'&&t.due_date&&t.due_date<today).length;
    const actual=state.data.executions.reduce((a,e)=>a+Number(e.actual_minutes),0);
    const p=state.selectedPlan?planById(state.selectedPlan):null;
    const action=`<button class="button button-primary" data-action="new-plan">＋ 새 계획</button>`;
    view.innerHTML=`${shellHeading('나의 리듬','계획은 어떻게 흘러가고 있나요?','작은 계획과 실제 기록을 쌓아 다음 번을 조금 더 잘 준비해요.',action)}
      <div class="stat-grid">
        ${statCard('진행 중인 할 일',tasks.filter(t=>t.status!=='done').length,'지우지 않은 전체 할 일','blue')}
        ${statCard('완료한 할 일',completed,'현재 완료 상태','green')}
        ${statCard('지연된 할 일',due,'오늘 이전 마감 · 미완료','amber')}
        ${statCard('실제 기록 시간',mins(actual),'저장된 실행 기록 합계','purple')}
      </div>
      <div class="content-grid home-grid"><section class="panel"><div class="section-heading"><div><div class="eyebrow">MY PLANS</div><h2>나의 계획</h2></div><a class="text-link" href="#plans">모두 보기 →</a></div>
        ${state.data.plans.length?`<div class="plan-card-grid">${state.data.plans.slice(0,3).map(planCard).join('')}</div>`:emptyState('아직 계획이 없어요','지금 실제로 하고 있는 일 하나를 골라 첫 계획을 세워보세요.','새 계획 만들기','new-plan')}
      </section>
      <section class="panel"><div class="section-heading"><div><div class="eyebrow">NEXT STEP</div><h2>오늘의 흐름</h2></div><a class="text-link" href="#review">돌아보기 →</a></div>
        ${tasks.length?`<div class="task-list">${tasks.filter(t=>t.status!=='done').slice(0,4).map(t=>taskCard(t,true)).join('')}</div>`:emptyState('기록을 기다리고 있어요','계획에 할 일을 추가하면 여기에 나타납니다.','계획 살펴보기','go-plans')}
      </section></div>
      <section class="reflection-banner"><div class="reflection-icon">↗</div><div><strong>다음 계획에 가져갈 한 가지를 찾아보세요</strong><p>예상과 실제의 차이를 확인하고, 다음 계획을 더 나답게 조정해 보세요.</p></div><a class="button button-light" href="#review">돌아보기 열기</a></section>`;
  }
  function statCard(label,value,detail,tone) {
    return `<button class="stat-card stat-${tone}" type="button" data-action="stat-nav"><span class="stat-label">${label}</span><strong>${esc(value)}</strong><span class="stat-detail">${detail}</span></button>`;
  }
  function emptyState(title,body,button,action) {
    return `<div class="empty-state"><span class="empty-orbit">✳</span><strong>${title}</strong><p>${body}</p><button class="button button-outline" type="button" data-action="${action}">${button}</button></div>`;
  }
  function renderPlans() {
    const active=state.selectedPlan?planById(state.selectedPlan):null;
    const planAction=`<button class="button button-primary" data-action="new-plan">＋ 새 계획</button>`;
    const list=state.data.plans;
    const tasks=active?filteredTasks(active.id):[];
    const tags=[...new Set(state.data.tasks.flatMap(t=>t.tags||[]))].sort((a,b)=>a.localeCompare(b,'ko'));
    view.innerHTML=`${shellHeading('PLAN & DO','계획과 할 일','계획을 세우고, 할 일을 정리하고, 실제 실행을 기록합니다.',planAction)}
      <div class="plans-layout"><aside class="plan-sidebar"><div class="section-heading"><h2>계획 목록 <span class="count-badge">${list.length}</span></h2></div>
        ${list.length?`<div class="plan-stack">${list.map(planCard).join('')}</div>`:emptyState('첫 계획을 시작해요','지금 하고 있는 일을 기간과 성공 기준으로 정리해 보세요.','계획 만들기','new-plan')}
      </aside>
      <section class="panel task-panel">${active?`
        <div class="plan-detail-head"><div><div class="eyebrow">${esc(fmtDate(active.start_date))} — ${esc(fmtDate(active.end_date))}</div><h2>${esc(active.title)}</h2><p>${esc(active.success_criteria)}</p></div><div class="button-row"><button class="button button-outline button-small" data-action="plan-history" data-id="${esc(active.id)}">수정 이력</button><button class="button button-outline button-small" data-action="edit-plan" data-id="${esc(active.id)}">계획 수정</button></div></div>
        <div class="plan-facts"><span>우선순위 <b>${esc(priorityLabel(active.priority))}</b></span><span>예상 시간 <b>${esc(mins(active.estimated_minutes))}</b></span><span>할 일 <b>${tasksFor(active.id).length}</b></span></div>
        ${state.data.handoffs.filter(h=>h.target_plan_id===active.id).map(h=>`<aside class="handoff-note"><span>이전 회고에서 가져온 점</span><p>${esc(h.insight_text)}</p></aside>`).join('')}
        <div class="section-heading task-heading"><div><h3>할 일</h3><span class="microcopy">마감일 오름차순 → 우선순위 높은 순 → 생성 순서</span></div><button class="button button-primary button-small" data-action="new-task" data-id="${esc(active.id)}">＋ 할 일 추가</button></div>
        <div class="filter-bar"><label class="search-field"><span aria-hidden="true">⌕</span><input id="taskSearch" type="search" placeholder="할 일 검색" value="${esc(state.filters.q)}"></label>
          <select id="taskStatus" aria-label="상태 필터"><option value="all" ${state.filters.status==='all'?'selected':''}>모든 상태</option><option value="todo" ${state.filters.status==='todo'?'selected':''}>진행 중</option><option value="done" ${state.filters.status==='done'?'selected':''}>완료</option></select>
          <select id="taskPriority" aria-label="우선순위 필터"><option value="all">모든 우선순위</option>${[5,4,3,2,1].map(n=>`<option value="${n}" ${state.filters.priority==n?'selected':''}>${esc(priorityLabel(n))}</option>`).join('')}</select>
          <select id="taskTag" aria-label="태그 필터"><option value="all">모든 태그</option>${tags.map(t=>`<option value="${esc(t)}" ${state.filters.tag===t?'selected':''}>${esc(t)}</option>`).join('')}</select></div>
        <div id="taskList" class="task-list">${tasks.length?tasks.map(t=>taskCard(t)).join(''):emptyState('조건에 맞는 할 일이 없어요','검색어나 필터를 바꾸거나 새 할 일을 추가해 보세요.','할 일 추가','new-task')}</div>
        <div class="task-count-note">${tasks.length}개 표시 · 삭제한 항목은 목록과 회고에서 제외됩니다.</div>
      `:`<div class="empty-panel">${emptyState('계획을 선택해 주세요','왼쪽 목록에서 계획을 선택하거나 새 계획을 만들어 보세요.','새 계획 만들기','new-plan')}</div>`}</section></div>`;
    bindFilters();
  }
  function filteredTasks(planId) {
    const f=state.filters, q=f.q.trim().toLocaleLowerCase('ko');
    return tasksFor(planId).filter(t=>{
      const searchable=[t.title,t.description,...(t.tags||[])].join(' ').toLocaleLowerCase('ko');
      return (!q||searchable.includes(q)) && (f.status==='all'||t.status===f.status) && (f.priority==='all'||Number(t.priority)===Number(f.priority)) && (f.tag==='all'||(t.tags||[]).includes(f.tag));
    }).sort((a,b)=>{
      if(!!a.due_date!==!!b.due_date) return a.due_date? -1:1;
      if(a.due_date!==b.due_date) return a.due_date.localeCompare(b.due_date);
      if(Number(a.priority)!==Number(b.priority)) return Number(b.priority)-Number(a.priority);
      return a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id);
    });
  }
  function bindFilters() {
    const search=$('#taskSearch'); if(!search) return;
    const rerender=()=>{state.filters.q=$('#taskSearch')?.value||'';state.filters.status=$('#taskStatus')?.value||'all';state.filters.priority=$('#taskPriority')?.value||'all';state.filters.tag=$('#taskTag')?.value||'all'; const box=$('#taskList'); const arr=filteredTasks(state.selectedPlan); box.innerHTML=arr.length?arr.map(t=>taskCard(t)).join(''):emptyState('조건에 맞는 할 일이 없어요','검색어나 필터를 바꾸거나 새 할 일을 추가해 보세요.','할 일 추가','new-task');};
    search.addEventListener('input',rerender); $('#taskStatus').addEventListener('change',rerender); $('#taskPriority').addEventListener('change',rerender); $('#taskTag').addEventListener('change',rerender);
  }
  function renderReview() {
    const data=state.review;
    if(!data) { view.innerHTML='<div class="loading-state">회고 자료를 불러오고 있어요…</div>'; return; }
    const s=data.summary, tasks=data.tasks;
    const from=$('#reviewFrom')?.value||localDate(new Date(Date.now()-29*86400000));
    const to=$('#reviewTo')?.value||localDate();
    const filtered=reviewTasks();
    const insightCards=[['계획한 할 일',s.task_count,'기간 내 계획에 연결된 삭제되지 않은 할 일','all','blue'],['완료',s.completed_count,'현재 완료 상태인 할 일','done','green'],['지연',s.overdue_count,'마감일이 오늘 전인 미완료 할 일','overdue','amber'],['막힘',s.blocked_count,'막힘 이유가 적힌 할 일','blocked','rose']];
    view.innerHTML=`${shellHeading('REFLECT','돌아보기','숫자만 확인하지 말고, 그 숫자가 나온 기록까지 따라가 보세요.','')}
      <section class="panel review-period"><div><div class="eyebrow">REVIEW PERIOD</div><h2>돌아볼 기간</h2><p>계획 기간이 선택 범위와 겹치는 할 일을 모읍니다.</p></div><div class="date-range"><label>시작일<input type="date" id="reviewFrom" value="${esc(from)}"></label><span>—</span><label>종료일<input type="date" id="reviewTo" value="${esc(to)}"></label><button class="button button-primary button-small" id="applyReview">적용</button></div></section>
      <div class="review-stat-grid">${insightCards.map(([label,value,desc,key,tone])=>`<button class="review-stat stat-${tone} ${state.reviewFilter===key?'chosen':''}" type="button" data-review-filter="${key}"><span>${label}<i class="trace-icon">↗</i></span><strong>${value}</strong><small>${desc}</small><em>근거 기록 보기</em></button>`).join('')}</div>
      <section class="panel time-panel"><div class="section-heading"><div><div class="eyebrow">ESTIMATED & ACTUAL</div><h2>예상과 실제 시간</h2></div><span class="unit-badge">단위: 분</span></div><div class="time-comparison"><button class="time-value" type="button" data-review-filter="estimated"><span>예상 시간</span><strong>${esc(mins(s.estimated_minutes))}</strong><em>근거 보기</em></button><span class="time-operator">→</span><button class="time-value" type="button" data-review-filter="actual"><span>실제 시간</span><strong>${esc(mins(s.actual_minutes))}</strong><em>근거 보기</em></button><span class="time-operator">=</span><button class="time-value difference ${s.difference_minutes>0?'over':s.difference_minutes<0?'under':''}" type="button" data-review-filter="difference"><span>차이 (실제 − 예상)</span><strong>${s.difference_minutes>0?'+':''}${esc(mins(s.difference_minutes))}</strong><em>비교 기록 보기</em></button></div><p class="time-caption">예상은 대상 할 일의 시간 합계, 실제는 연결된 실행 기록의 시간 합계입니다. 기록이 없으면 0분으로 계산합니다.</p></section>
      <section class="panel evidence-panel"><div class="section-heading"><div><div class="eyebrow">EVIDENCE</div><h2>${esc(reviewFilterTitle())}</h2></div><span class="count-badge">${filtered.length}</span></div>
        ${filtered.length?`<div class="evidence-list">${filtered.map(t=>evidenceTask(t)).join('')}</div>`:emptyState('해당하는 기록이 없어요','기간이나 집계 기준을 바꾸어 확인해 보세요.','전체 기록 보기','review-all')}</section>
      <section class="panel handoff-panel"><div><div class="eyebrow">TAKE IT FORWARD</div><h2>다음 계획으로 가져갈 점</h2><p>회고에서 정한 개선점 한 가지를 다음 계획에 연결해 둡니다.</p></div><button class="button button-primary" data-action="handoff">개선점 넘기기</button></section>`;
    $('#applyReview').addEventListener('click', async()=>{try{await loadReview();state.reviewFilter='all';render();}catch(e){showError(e);}});
  }
  function reviewTasks() {
    const list=state.review?.tasks||[];
    if(state.reviewFilter==='done') return list.filter(t=>t.status==='done');
    if(state.reviewFilter==='overdue') return list.filter(t=>t.status!=='done'&&t.due_date&&t.due_date<state.review.today_seoul);
    if(state.reviewFilter==='blocked') return list.filter(t=>(t.executions||[]).some(e=>e.blocker_reason.trim()));
    if(state.reviewFilter==='estimated') return list.filter(t=>Number(t.estimated_minutes)>0);
    if(state.reviewFilter==='actual') return list.filter(t=>(t.executions||[]).length>0);
    if(state.reviewFilter==='difference') return list.filter(t=>Number(t.estimated_minutes)>0||(t.executions||[]).length>0);
    return list;
  }
  function reviewFilterTitle() {return ({all:'회고 대상 기록',done:'완료 기록',overdue:'지연 근거 기록',blocked:'막힘 근거 기록',estimated:'예상 시간 근거 기록',actual:'실제 시간 근거 기록',difference:'예상과 실제 비교 기록'})[state.reviewFilter]||'회고 대상 기록';}
  function evidenceTask(t) {
    const executions=t.executions||[];
    return `<article class="evidence-row"><div class="evidence-main"><div class="evidence-titleline"><strong>${esc(t.title)}</strong><span class="status-pill ${t.status==='done'?'pill-done':''}">${statusLabel(t.status)}</span></div><div class="task-meta"><span>${esc(t.plan_title)}</span><span class="dot">·</span><span>${esc(fmtDate(t.due_date))}</span><span class="dot">·</span><span>예상 ${esc(mins(t.estimated_minutes))}</span></div>
      ${executions.map(e=>`<div class="execution-chip"><span class="execution-icon">↳</span><span>${esc(new Date(e.started_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))} 시작</span><span>실제 ${esc(mins(e.actual_minutes))}</span>${e.blocker_reason?`<span class="blocker-text">막힘: ${esc(e.blocker_reason)}</span>`:''}</div>`).join('')||'<div class="execution-chip muted">연결된 실행 기록 없음 · 실제 0분</div>'}</div>
      <button class="icon-button" type="button" data-action="task-detail" data-id="${esc(t.id)}">상세</button></article>`;
  }
  function field(label,name,value='',type='text',extra='') {return `<label class="form-field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra} required></label>`;}
  function planForm(plan=null) {
    openModal(`<div class="eyebrow">${plan?'EDIT PLAN':'NEW PLAN'}</div><h2>${plan?'계획 수정':'새 계획 세우기'}</h2><p class="modal-intro">실제로 하고 있는 일을 골라 내 기준으로 적어 주세요.</p>
      <form id="planForm" class="form-grid">
        <label class="form-field full"><span>계획 이름</span><input name="title" maxlength="160" value="${esc(plan?.title||'')}" placeholder="예: 주 3회 저녁 운동하기" required></label>
        ${field('시작일','start_date',plan?.start_date||localDate(),'date')}${field('종료일','end_date',plan?.end_date||localDate(),'date')}
        <label class="form-field"><span>우선순위</span><select name="priority" required>${[5,4,3,2,1].map(n=>`<option value="${n}" ${Number(plan?.priority||3)===n?'selected':''}>${priorityLabel(n)}</option>`).join('')}</select></label>
        ${field('예상 시간 (분)','estimated_minutes',plan?.estimated_minutes||0,'number','min="0" step="1"')}
        <label class="form-field full"><span>성공 기준</span><textarea name="success_criteria" maxlength="2000" placeholder="무엇을 달성하면 성공인지 구체적으로 적어 주세요." required>${esc(plan?.success_criteria||'')}</textarea></label>
        <div class="form-actions full"><button class="button button-outline" type="button" data-action="close-modal">취소</button><button class="button button-primary" type="submit">${plan?'수정 저장':'계획 저장'}</button></div>
      </form>`);
    $('#planForm').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));data.priority=Number(data.priority);data.estimated_minutes=Number(data.estimated_minutes);try{await api(plan?`/api/plans/${plan.id}`:'/api/plans',{method:plan?'PATCH':'POST',body:JSON.stringify(data)});closeModal();await refresh();toast(plan?'계획을 수정하고 이전 값을 이력에 남겼어요.':'새 계획을 저장했어요.');}catch(err){showError(err);}});
  }
  function taskForm(task=null, planId=state.selectedPlan) {
    if(!planId){toast('먼저 계획을 선택해 주세요.',true);return;}
    const tags=(task?.tags||[]).join(', ');
    openModal(`<div class="eyebrow">${task?'EDIT TASK':'NEW TASK'}</div><h2>${task?'할 일 수정':'계획에 할 일 추가'}</h2><p class="modal-intro">마감일과 예상 시간도 기록하면 돌아보기에서 비교할 수 있어요.</p>
      <form id="taskForm" class="form-grid">
        <label class="form-field full"><span>할 일</span><input name="title" maxlength="240" value="${esc(task?.title||'')}" placeholder="예: 운동복 준비하기" required></label>
        <label class="form-field full"><span>설명 (선택)</span><textarea name="description" maxlength="4000" placeholder="필요한 내용을 간단히 적어 주세요.">${esc(task?.description||'')}</textarea></label>
        <label class="form-field"><span>마감일 (선택)</span><input name="due_date" type="date" value="${esc(task?.due_date||'')}"></label>
        <label class="form-field"><span>우선순위</span><select name="priority">${[5,4,3,2,1].map(n=>`<option value="${n}" ${Number(task?.priority||3)===n?'selected':''}>${priorityLabel(n)}</option>`).join('')}</select></label>
        ${field('예상 시간 (분)','estimated_minutes',task?.estimated_minutes??30,'number','min="0" step="1"')}
        <label class="form-field"><span>태그 (쉼표로 구분)</span><input name="tags" value="${esc(tags)}" placeholder="건강, 저녁"></label>
        <div class="form-actions full"><button class="button button-outline" type="button" data-action="close-modal">취소</button><button class="button button-primary" type="submit">${task?'수정 저장':'할 일 저장'}</button></div>
      </form>`);
    $('#taskForm').addEventListener('submit',async e=>{e.preventDefault();const raw=Object.fromEntries(new FormData(e.currentTarget));raw.plan_id=planId;raw.priority=Number(raw.priority);raw.estimated_minutes=Number(raw.estimated_minutes);raw.tags=raw.tags.split(',').map(x=>x.trim()).filter(Boolean);try{await api(task?`/api/tasks/${task.id}`:'/api/tasks',{method:task?'PATCH':'POST',body:JSON.stringify(raw)});closeModal();await refresh();toast(task?'할 일을 수정했어요.':'할 일을 추가했어요.');}catch(err){showError(err);}});
  }
  function completionForm(task) {
    const start=localDateTime(new Date(Date.now()-30*60000)), end=localDateTime();
    const idempotencyKey=crypto.randomUUID();
    openModal(`<div class="eyebrow">RECORD ACTUAL WORK</div><h2>실행 기록과 함께 완료</h2><p class="modal-intro"><strong>${esc(task.title)}</strong>의 실제 실행을 남겨요. 예상 계획값은 바뀌지 않습니다.</p>
      <form id="completionForm" class="form-grid">
        ${field('시작 시각','started_at',start,'datetime-local')}${field('끝난 시각','ended_at',end,'datetime-local')}
        ${field('실제로 걸린 시간 (분)','actual_minutes','30','number','min="0" step="1"')}
        <label class="form-field full"><span>막혔던 이유 (없으면 비워 두세요)</span><textarea name="blocker_reason" maxlength="2000" placeholder="예: 갑작스러운 일정 때문에 시작이 늦어짐"></textarea></label>
        <div class="form-actions full"><button class="button button-outline" type="button" data-action="close-modal">취소</button><button class="button button-primary" type="submit">기록 저장하고 완료</button></div>
      </form>`);
    $('#completionForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const submit=form.querySelector('button[type="submit"]');if(submit.disabled)return;submit.disabled=true;const raw=Object.fromEntries(new FormData(form));raw.started_at=seoulDateTimeToUtc(raw.started_at);raw.ended_at=seoulDateTimeToUtc(raw.ended_at);raw.actual_minutes=Number(raw.actual_minutes);raw.idempotency_key=idempotencyKey;try{const result=await api(`/api/tasks/${task.id}/complete`,{method:'POST',body:JSON.stringify(raw)});closeModal();await refresh();toast(result.duplicate?'이미 완료되어 있어 기록을 추가하지 않았어요.':'실행 기록을 저장하고 완료했어요.');}catch(err){submit.disabled=false;showError(err);}});
  }
  function executionForm(task) {
    const start=localDateTime(new Date(Date.now()-30*60000)), end=localDateTime();
    const idempotencyKey=crypto.randomUUID();
    openModal(`<div class="eyebrow">EXECUTION LOG</div><h2>실행 기록 추가</h2><p class="modal-intro"><strong>${esc(task.title)}</strong>에 실제로 한 일을 연결합니다.</p>
      <form id="executionForm" class="form-grid">${field('시작 시각','started_at',start,'datetime-local')}${field('끝난 시각','ended_at',end,'datetime-local')}${field('실제 시간 (분)','actual_minutes','30','number','min="0" step="1"')}<label class="form-field full"><span>막혔던 이유 (선택)</span><textarea name="blocker_reason" maxlength="2000"></textarea></label><div class="form-actions full"><button class="button button-outline" type="button" data-action="close-modal">취소</button><button class="button button-primary" type="submit">기록 저장</button></div></form>`);
    $('#executionForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,submit=form.querySelector('button[type="submit"]');if(submit.disabled)return;submit.disabled=true;const raw=Object.fromEntries(new FormData(form));raw.started_at=seoulDateTimeToUtc(raw.started_at);raw.ended_at=seoulDateTimeToUtc(raw.ended_at);raw.actual_minutes=Number(raw.actual_minutes);raw.idempotency_key=idempotencyKey;try{await api(`/api/tasks/${task.id}/executions`,{method:'POST',body:JSON.stringify(raw)});closeModal();await refresh();toast('실행 기록을 저장했어요.');}catch(err){submit.disabled=false;showError(err);}});
  }
  function detail(task) {
    const plan=planById(task.plan_id), executions=state.data.executions.filter(e=>e.task_id===task.id);
    openModal(`<div class="eyebrow">TASK RECORD</div><h2>${esc(task.title)}</h2><div class="detail-facts"><span>${esc(plan?.title||'계획')}</span><span>${esc(statusLabel(task.status))}</span><span>마감 ${esc(fmtDate(task.due_date))}</span></div>
      <div class="detail-block"><h3>할 일 정보</h3><p>${esc(task.description||'추가 설명이 없습니다.')}</p><div class="tag-list">${(task.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><p>우선순위 ${esc(priorityLabel(task.priority))} · 예상 ${esc(mins(task.estimated_minutes))}</p></div>
      <div class="detail-block"><h3>실행 기록 ${executions.length}건</h3>${executions.length?executions.map(e=>`<div class="execution-detail"><span>${esc(new Date(e.started_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}</span><span>${esc(mins(e.actual_minutes))}</span>${e.blocker_reason?`<p>막힘: ${esc(e.blocker_reason)}</p>`:''}</div>`).join(''):'<p class="muted">아직 실행 기록이 없습니다.</p>'}</div>
      <div class="form-actions"><button class="button button-outline" type="button" data-action="close-modal">닫기</button><button class="button button-soft" type="button" data-action="add-execution" data-id="${esc(task.id)}">실행 기록 추가</button><button class="button button-primary" type="button" data-action="edit-task" data-id="${esc(task.id)}">할 일 수정</button></div>`);
  }
  function history(plan) {
    const entries=state.data.revisions.filter(r=>r.plan_id===plan.id);
    openModal(`<div class="eyebrow">PLAN HISTORY</div><h2>계획 수정 이력</h2><p class="modal-intro">현재 계획: ${esc(plan.title)} · 과거 버전은 수정 전 스냅샷입니다.</p>${entries.length?`<div class="history-list">${entries.map(r=>`<article class="history-card"><div><strong>수정 ${r.revision_no}회 전 값</strong><time>${esc(new Date(r.recorded_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}</time></div><b>${esc(r.snapshot.title)}</b><p>${esc(fmtDate(r.snapshot.start_date))} – ${esc(fmtDate(r.snapshot.end_date))} · 우선순위 ${esc(priorityLabel(r.snapshot.priority))} · 예상 ${esc(mins(r.snapshot.estimated_minutes))}</p><p>${esc(r.snapshot.success_criteria)}</p></article>`).join('')}</div>`:'<div class="empty-state compact-empty"><strong>아직 수정 이력이 없어요</strong><p>계획을 수정하면 이전 값이 여기에 보존됩니다.</p></div>'}<div class="form-actions"><button class="button button-primary" type="button" data-action="close-modal">확인</button></div>`);
  }
  function handoffForm() {
    const source=state.selectedPlan?planById(state.selectedPlan):state.data.plans[0];
    if(!source){toast('먼저 계획을 만들어 주세요.',true);return;}
    const targets=state.data.plans.filter(p=>p.id!==source.id);
    if(!targets.length){toast('개선점을 넘길 다음 계획을 먼저 만들어 주세요.',true);location.hash='#plans';return;}
    openModal(`<div class="eyebrow">PLAN HANDOFF</div><h2>다음 계획으로 개선점 넘기기</h2><p class="modal-intro">출발 계획: <strong>${esc(source.title)}</strong></p><form id="handoffForm" class="form-grid"><label class="form-field full"><span>다음 계획</span><select name="target_plan_id" required>${targets.map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select></label><label class="form-field full"><span>다음에 바꿀 점 한 가지</span><textarea name="insight_text" maxlength="1000" placeholder="예: 저녁 시간에 계획한 일은 예상보다 15분 더 걸렸으니 다음에는 여유 시간을 둔다." required></textarea></label><div class="form-actions full"><button class="button button-outline" type="button" data-action="close-modal">취소</button><button class="button button-primary" type="submit">다음 계획에 저장</button></div></form>`);
    $('#handoffForm').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));try{await api(`/api/plans/${source.id}/handoffs`,{method:'POST',body:JSON.stringify(data)});closeModal();await refresh();toast('개선점을 다음 계획에 연결했어요.');}catch(err){showError(err);}});
  }

  document.addEventListener('click',async e=>{
    const filter=e.target.closest('[data-review-filter]'); if(filter){state.reviewFilter=filter.dataset.reviewFilter;render();return;}
    const el=e.target.closest('[data-action]'); if(!el)return;
    const action=el.dataset.action, id=el.dataset.id;
    try {
      if(action==='new-plan') planForm();
      else if(action==='edit-plan') planForm(planById(id));
      else if(action==='select-plan'){state.selectedPlan=id;state.filters={q:'',status:'all',priority:'all',tag:'all'};if(currentHash()!=='plans')location.hash='#plans';else render();}
      else if(action==='new-task') taskForm(null,id||state.selectedPlan);
      else if(action==='edit-task'){const t=taskById(id);if(t){closeModal();taskForm(t,t.plan_id);}}
      else if(action==='task-detail'){const t=taskById(id);if(t)detail(t);}
      else if(action==='plan-history'){history(planById(id));}
      else if(action==='toggle'){const t=taskById(id);if(t?.status==='done'){await api(`/api/tasks/${id}/status`,{method:'PATCH',body:JSON.stringify({status:'todo'})});await refresh();toast('진행 중으로 되돌렸어요.');}else if(t)completionForm(t);}
      else if(action==='delete-task'){const t=taskById(id);if(t&&confirm(`“${t.title}”을(를) 목록에서 삭제할까요? 회고 집계에서는 제외됩니다.`)){await api(`/api/tasks/${id}`,{method:'DELETE'});await refresh();toast('할 일을 삭제했어요.');}}
      else if(action==='add-execution'){const t=taskById(id);if(t)executionForm(t);}
      else if(action==='handoff') handoffForm();
      else if(action==='close-modal') closeModal();
      else if(action==='go-plans'){location.hash='#plans';}
      else if(action==='review-all'){state.reviewFilter='all';render();}
      else if(action==='stat-nav'){location.hash='#review';}
    } catch(err){showError(err);}
  });
  document.addEventListener('submit',e=>{if(e.target.id==='planForm'||e.target.id==='taskForm') e.preventDefault();});
  $('#exportButton').addEventListener('click',async()=>{try{const response=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok){const body=await response.json();throw new Error(body.error||'내보내기에 실패했습니다.');}const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='t06-export.json';a.click();URL.revokeObjectURL(url);toast('모든 자료를 JSON 파일로 내보냈어요.');}catch(err){showError(err);}});
  $('#dismissNotice').addEventListener('click',()=>{$('.privacy-notice').classList.add('notice-hidden');});
  window.addEventListener('hashchange',async()=>{try{if(currentHash()==='review')await loadReview();render();}catch(e){showError(e);}});
  (async()=>{try{await refresh();}catch(e){view.innerHTML=`<div class="startup-error"><h1>자료에 연결할 수 없어요</h1><p>${esc(e.message)}</p><button class="button button-primary" onclick="location.reload()">다시 불러오기</button></div>`;}})();
})();
