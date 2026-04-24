/* TCAM ACL Simulator – Frontend (no backend, pure in-memory) */

let tcams = {};          // id -> { tcam, name, id, implicitDenyIndex, history, progHistory }
let currentTcamId = null;
let editingIndex = null;
let expandedRows = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function $(id) { return document.getElementById(id); }

function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.classList.remove('hidden');
}
function hideError(id) { $(id).classList.add('hidden'); }

function showNotice(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.classList.remove('hidden');
}
function hideNotice(id) { $(id).classList.add('hidden'); }

function formatTime(iso) { return new Date(iso).toLocaleTimeString(); }

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function nowISO() { return new Date().toISOString(); }

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function ipToRawBits(ip) {
    const parts = ip.split('.').map(Number);
    let bits = '';
    for (let i = 0; i < 4; i++) {
        for (let b = 7; b >= 0; b--) {
            bits += (parts[i] >> b) & 1;
        }
    }
    return bits;
}

function formatWordBits(sipBits, dipBits) {
    const all = sipBits + dipBits;
    const groups = [];
    for (let i = 0; i < 64; i += 8) {
        groups.push(all.substring(i, i + 8));
    }
    return groups.slice(0, 4).join(' ') + ' \u2502 ' + groups.slice(4).join(' ');
}

// ---------------------------------------------------------------------------
// TCAM entry helpers
// ---------------------------------------------------------------------------

function entryToDict(idx, e, isImplicit) {
    if (!e.valid) {
        return { index: idx, valid: false, implicit: false };
    }
    const packed_val = e.value[0];
    const packed_mask = e.mask[0];
    const sip_val = Number((packed_val >> 32n) & 0xFFFFFFFFn);
    const dip_val = Number(packed_val & 0xFFFFFFFFn);
    const sip_mask = Number((packed_mask >> 32n) & 0xFFFFFFFFn);
    const dip_mask = Number(packed_mask & 0xFFFFFFFFn);
    return {
        index: idx,
        valid: true,
        implicit: isImplicit,
        value_sip: intToIp(sip_val),
        value_dip: intToIp(dip_val),
        mask_sip: intToIp(sip_mask),
        mask_dip: intToIp(dip_mask),
        action: e.action,
    };
}

function getUsedCount(entry) {
    let count = 0;
    for (let i = 0; i < entry.tcam.depth; i++) {
        if (i !== entry.implicitDenyIndex && entry.tcam.isValid(i)) count++;
    }
    return count;
}

// ---------------------------------------------------------------------------
// List View
// ---------------------------------------------------------------------------

function loadList() {
    const tbody = $('tcam-table').querySelector('tbody');
    tbody.innerHTML = '';
    const ids = Object.keys(tcams);
    if (ids.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">No TCAMs yet</td></tr>';
        return;
    }
    for (const id of ids) {
        const t = tcams[id];
        const used = getUsedCount(t);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="tcam-name">${esc(t.name)}</td>
            <td>${t.tcam.width}</td>
            <td>${t.tcam.depth}</td>
            <td>${used} / ${t.tcam.depth - 1}</td>
            <td>
                <button onclick="openTcam('${t.id}')">Open</button>
                <button class="danger" onclick="deleteTcam('${t.id}','${esc(t.name)}')">Delete</button>
            </td>`;
        const nameCell = tr.querySelector('.tcam-name');
        nameCell.addEventListener('dblclick', () => makeEditable(nameCell, t.id, loadList));
        tbody.appendChild(tr);
    }
}

function showList() {
    currentTcamId = null;
    $('list-view').classList.remove('hidden');
    $('detail-view').classList.add('hidden');
    loadList();
}

// ---------------------------------------------------------------------------
// Create Modal
// ---------------------------------------------------------------------------

function showCreateModal() {
    hideError('create-error');
    $('create-modal').classList.remove('hidden');
}
function hideCreateModal() { $('create-modal').classList.add('hidden'); }

function createTcam() {
    hideError('create-error');
    const name = $('create-name').value.trim();
    const width = parseInt($('create-width').value, 10);
    const depth = parseInt($('create-depth').value, 10);
    if (!name) { showError('create-error', 'Name is required'); return; }
    try {
        const t = new TCAM(width, depth);
        const denyIdx = depth - 1;
        const denyValue = TCAM.packSipDip(0, 0);
        const denyMask = TCAM.packSipDip(0, 0);
        t.program(denyIdx, denyValue, denyMask, 'deny');

        const id = uuid();
        tcams[id] = {
            tcam: t, name, id,
            implicitDenyIndex: denyIdx,
            history: [],
            progHistory: [],
        };
        hideCreateModal();
        loadList();
    } catch (e) {
        showError('create-error', e.message);
    }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function deleteTcam(id, name) {
    if (!confirm(`Delete TCAM "${name}"? This cannot be undone.`)) return;
    delete tcams[id];
    loadList();
}

// ---------------------------------------------------------------------------
// Detail View
// ---------------------------------------------------------------------------

function openTcam(id) {
    currentTcamId = id;
    expandedRows = new Set();
    $('list-view').classList.add('hidden');
    $('detail-view').classList.remove('hidden');
    hideError('program-error');
    hideError('lookup-error');
    hideNotice('program-notice');
    $('lookup-result').classList.add('hidden');
    resetProgForm();
    const title = $('detail-title');
    title.ondblclick = () => makeEditable(title, id, refreshDetail);
    refreshDetail();
}

function refreshDetail() {
    if (!currentTcamId) return;
    const entry = tcams[currentTcamId];
    if (!entry) return;
    const t = entry.tcam;
    $('detail-title').textContent = entry.name;
    const used = getUsedCount(entry);
    $('detail-meta').textContent = `width=${t.width}  depth=${t.depth}  used=${used}/${t.depth - 1}`;

    const entries = [];
    for (let i = 0; i < t.depth; i++) {
        entries.push(entryToDict(i, t.getEntry(i), i === entry.implicitDenyIndex));
    }
    renderEntries(entries);
    renderHistory(entry.history);
    renderProgHistory(entry.progHistory);
}

function toggleEntryExpand(index) {
    if (expandedRows.has(index)) {
        expandedRows.delete(index);
    } else {
        expandedRows.add(index);
    }
    refreshDetail();
}

function renderEntries(entries) {
    const tbody = $('entries-table').querySelector('tbody');
    tbody.innerHTML = '';
    for (const e of entries) {
        const tr = document.createElement('tr');
        const isExpandable = e.valid || e.implicit;
        const isExpanded = expandedRows.has(e.index);
        const chevron = isExpandable
            ? `<span class="chevron">${isExpanded ? '\u25BC' : '\u25B6'}</span> `
            : '';

        if (e.implicit) {
            tr.className = 'implicit expandable' + (isExpanded ? ' expanded' : '');
            tr.innerHTML = `
                <td>${chevron}${e.index}</td>
                <td>Yes</td>
                <td class="mono">${e.value_sip}</td>
                <td class="mono">${e.mask_sip}</td>
                <td class="mono">${e.value_dip}</td>
                <td class="mono">${e.mask_dip}</td>
                <td><span class="badge deny">${e.action}</span> <em>(implicit)</em></td>
                <td></td>`;
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', () => toggleEntryExpand(e.index));
        } else if (e.valid) {
            tr.className = 'expandable' + (isExpanded ? ' expanded' : '');
            tr.innerHTML = `
                <td>${chevron}${e.index}</td>
                <td>Yes</td>
                <td class="mono">${e.value_sip}</td>
                <td class="mono">${e.mask_sip}</td>
                <td class="mono">${e.value_dip}</td>
                <td class="mono">${e.mask_dip}</td>
                <td><span class="badge ${e.action}">${e.action}</span></td>
                <td>
                    <button onclick="editEntry(${e.index},'${e.value_sip}','${e.mask_sip}','${e.value_dip}','${e.mask_dip}','${e.action}')">Edit</button>
                    <button class="danger" onclick="invalidateEntry(${e.index})">Invalidate</button>
                </td>`;
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', (ev) => {
                if (ev.target.closest('button')) return;
                toggleEntryExpand(e.index);
            });
        } else {
            tr.className = 'invalid';
            tr.innerHTML = `
                <td>${e.index}</td>
                <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
                <td><button onclick="prefillProgram(${e.index})">Program</button></td>`;
        }
        tbody.appendChild(tr);

        if (isExpandable && isExpanded) {
            const sub = document.createElement('tr');
            sub.className = 'bit-row';
            const vLine = formatWordBits(ipToRawBits(e.value_sip), ipToRawBits(e.value_dip));
            const mLine = formatWordBits(ipToRawBits(e.mask_sip), ipToRawBits(e.mask_dip));
            sub.innerHTML = `<td colspan="8"><div class="bit-detail"><span class="mono">V: ${vLine}</span><br><span class="mono">M: ${mLine}</span></div></td>`;
            tbody.appendChild(sub);
        }
    }
}

// ---------------------------------------------------------------------------
// Packet Lookup History
// ---------------------------------------------------------------------------

function renderHistory(history) {
    const tbody = $('history-table').querySelector('tbody');
    tbody.innerHTML = '';
    if (history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888">No lookups yet</td></tr>';
        return;
    }
    for (const h of history) {
        const tr = document.createElement('tr');
        let res;
        if (h.implicit) {
            res = `<span style="color:#888">implicit deny (entry ${h.index})</span>`;
        } else if (h.hit) {
            res = `<span class="badge permit">Hit #${h.index}</span> <span class="badge ${h.action}">${h.action}</span>`;
        } else {
            res = '<span style="color:#888">miss</span>';
        }
        tr.innerHTML = `
            <td>${formatTime(h.timestamp)}</td>
            <td class="mono">${esc(h.sip)}</td>
            <td class="mono">${esc(h.dip)}</td>
            <td>${res}</td>`;
        tbody.appendChild(tr);
    }
}

// ---------------------------------------------------------------------------
// Programming History
// ---------------------------------------------------------------------------

function renderProgHistory(history) {
    const tbody = $('prog-history-table').querySelector('tbody');
    tbody.innerHTML = '';
    if (history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#888">No programming events</td></tr>';
        return;
    }
    for (const h of history) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatTime(h.timestamp)}</td>
            <td>${esc(h.operation)}</td>
            <td>${summarizeProgEvent(h)}</td>`;
        tbody.appendChild(tr);
    }
}

function summarizeProgEvent(h) {
    const d = h.details;
    switch (h.operation) {
        case 'program':
            return `Index ${d.index}: programmed`;
        case 'edit':
            return `Index ${d.index}: edited`;
        case 'invalidate':
            return `Index ${d.index}: invalidated`;
        case 'rename':
            return `"${esc(d.old_name)}" \u2192 "${esc(d.new_name)}"`;
        default:
            return JSON.stringify(d);
    }
}

function clearProgHistory() {
    const entry = tcams[currentTcamId];
    if (entry) entry.progHistory = [];
    refreshDetail();
}

// ---------------------------------------------------------------------------
// Program / Edit
// ---------------------------------------------------------------------------

function resetProgForm() {
    editingIndex = null;
    $('prog-index').value = '';
    $('prog-index').disabled = false;
    $('prog-sip').value = '';
    $('prog-sip-mask').value = '';
    $('prog-dip').value = '';
    $('prog-dip-mask').value = '';
    document.querySelector('input[name="prog-action"][value="permit"]').checked = true;
    $('prog-submit').textContent = 'Program';
    $('prog-form-title').textContent = 'Program ACE';
    hideNotice('program-notice');
    hideError('program-error');
}

function prefillProgram(index) {
    editingIndex = null;
    $('prog-index').value = index;
    $('prog-index').disabled = false;
    $('prog-sip').value = '';
    $('prog-sip-mask').value = '';
    $('prog-dip').value = '';
    $('prog-dip-mask').value = '';
    document.querySelector('input[name="prog-action"][value="permit"]').checked = true;
    $('prog-submit').textContent = 'Program';
    $('prog-form-title').textContent = 'Program ACE';
    hideNotice('program-notice');
    $('prog-sip').focus();
}

function editEntry(index, sip, sipMask, dip, dipMask, action) {
    editingIndex = index;
    $('prog-index').value = index;
    $('prog-index').disabled = true;
    $('prog-sip').value = sip;
    $('prog-sip-mask').value = sipMask;
    $('prog-dip').value = dip;
    $('prog-dip-mask').value = dipMask;
    document.querySelector(`input[name="prog-action"][value="${action}"]`).checked = true;
    $('prog-submit').textContent = 'Update';
    $('prog-form-title').textContent = `Edit ACE #${index}`;
    hideNotice('program-notice');
    $('prog-sip').focus();
}

function submitEntry() {
    hideError('program-error');
    hideNotice('program-notice');

    const entry = tcams[currentTcamId];
    if (!entry) return;

    const index = parseInt($('prog-index').value, 10);
    const sipStr = $('prog-sip').value.trim();
    const sipMaskStr = $('prog-sip-mask').value.trim();
    const dipStr = $('prog-dip').value.trim();
    const dipMaskStr = $('prog-dip-mask').value.trim();
    const action = document.querySelector('input[name="prog-action"]:checked').value;

    if (isNaN(index) || !sipStr || !sipMaskStr || !dipStr || !dipMaskStr) {
        showError('program-error', 'All fields are required');
        return;
    }

    if (index === entry.implicitDenyIndex) {
        showError('program-error', `Cannot modify the implicit deny entry at index ${index}`);
        return;
    }

    try {
        const sip = ipToInt(sipStr);
        const sipMask = ipToInt(sipMaskStr);
        const dip = ipToInt(dipStr);
        const dipMask = ipToInt(dipMaskStr);
        const value = TCAM.packSipDip(sip, dip);
        const mask = TCAM.packSipDip(sipMask, dipMask);

        const isEdit = editingIndex !== null;
        if (isEdit) {
            entry.tcam.update(index, value, mask, action);
            entry.progHistory.unshift({
                timestamp: nowISO(),
                operation: 'edit',
                details: { index },
            });
        } else {
            entry.tcam.program(index, value, mask, action);
            entry.progHistory.unshift({
                timestamp: nowISO(),
                operation: 'program',
                details: { index },
            });
        }

        editingIndex = null;
        $('prog-index').disabled = false;
        $('prog-submit').textContent = 'Program';
        $('prog-form-title').textContent = 'Program ACE';
        refreshDetail();
    } catch (e) {
        showError('program-error', e.message);
    }
}

// ---------------------------------------------------------------------------
// Invalidate
// ---------------------------------------------------------------------------

function invalidateEntry(index) {
    const entry = tcams[currentTcamId];
    if (!entry) return;
    try {
        entry.tcam.invalidate(index);
        entry.progHistory.unshift({
            timestamp: nowISO(),
            operation: 'invalidate',
            details: { index },
        });
        refreshDetail();
    } catch (e) {
        showError('program-error', e.message);
    }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function doLookup() {
    hideError('lookup-error');
    const entry = tcams[currentTcamId];
    if (!entry) return;

    const sipStr = $('lkp-sip').value.trim();
    const dipStr = $('lkp-dip').value.trim();
    if (!sipStr || !dipStr) {
        showError('lookup-error', 'SIP and DIP are required');
        return;
    }

    try {
        const sip = ipToInt(sipStr);
        const dip = ipToInt(dipStr);
        const hit = entry.tcam.lookupSipDip(sip, dip);

        const ts = nowISO();
        const isImplicit = hit !== null && hit.index === entry.implicitDenyIndex;
        const record = {
            sip: sipStr,
            dip: dipStr,
            hit: hit !== null,
            index: hit ? hit.index : null,
            action: hit ? hit.action : null,
            implicit: isImplicit,
            timestamp: ts,
        };
        entry.history.unshift(record);

        const box = $('lookup-result');
        box.classList.remove('hidden', 'hit', 'miss');
        if (isImplicit) {
            box.className = 'result-box miss';
            box.textContent = `MISS \u2192 implicit deny (entry ${hit.index})`;
        } else if (hit) {
            box.className = 'result-box hit';
            box.textContent = `Hit at index ${hit.index} \u2014 ${hit.action}`;
        } else {
            box.className = 'result-box miss';
            box.textContent = 'Miss \u2014 no matching entry';
        }
        refreshDetail();
    } catch (e) {
        showError('lookup-error', e.message);
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function clearHistory() {
    const entry = tcams[currentTcamId];
    if (entry) entry.history = [];
    refreshDetail();
}

// ---------------------------------------------------------------------------
// Rename (inline edit)
// ---------------------------------------------------------------------------

function makeEditable(el, tcamId, onDone) {
    const original = el.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = original;
    input.className = 'rename-input';
    input.style.fontSize = getComputedStyle(el).fontSize;
    input.style.fontWeight = getComputedStyle(el).fontWeight;

    function finish(save) {
        const val = input.value.trim();
        if (save && val && val !== original) {
            const entry = tcams[tcamId];
            if (entry) {
                const oldName = entry.name;
                entry.name = val;
                entry.progHistory.unshift({
                    timestamp: nowISO(),
                    operation: 'rename',
                    details: { old_name: oldName, new_name: val },
                });
            }
            el.textContent = val;
            if (onDone) onDone();
        } else {
            el.textContent = original;
        }
    }

    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));

    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadList();
