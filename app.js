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
        saveToStorage();
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
    saveToStorage();
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
        case 'batch': {
            let s = `${d.programmed} programmed`;
            if (d.errors) s += `, ${d.errors} failed`;
            return s;
        }
        case 'rename':
            return `"${esc(d.old_name)}" \u2192 "${esc(d.new_name)}"`;
        default:
            return JSON.stringify(d);
    }
}

function clearProgHistory() {
    const entry = tcams[currentTcamId];
    if (entry) entry.progHistory = [];
    saveToStorage();
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
        saveToStorage();
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
        saveToStorage();
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
        saveToStorage();

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
    saveToStorage();
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
                saveToStorage();
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
// Batch Import
// ---------------------------------------------------------------------------

function batchImport() {
    hideError('batch-error');
    hideNotice('batch-notice');

    const entry = tcams[currentTcamId];
    if (!entry) return;

    const text = $('batch-input').value.trim();
    if (!text) { showError('batch-error', 'Paste at least one line'); return; }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const parsed = [];
    for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split(',').map(s => s.trim());
        if (parts.length !== 6) {
            showError('batch-error', `Line ${i + 1}: expected 6 fields, got ${parts.length}`);
            return;
        }
        const [idxStr, sip, sipMask, dip, dipMask, action] = parts;
        const idx = parseInt(idxStr, 10);
        if (isNaN(idx)) {
            showError('batch-error', `Line ${i + 1}: invalid index "${idxStr}"`);
            return;
        }
        if (idx === entry.implicitDenyIndex) {
            showError('batch-error', `Line ${i + 1}: cannot program implicit deny index ${idx}`);
            return;
        }
        const act = action.toLowerCase();
        if (act !== 'permit' && act !== 'deny') {
            showError('batch-error', `Line ${i + 1}: action must be "permit" or "deny"`);
            return;
        }
        try {
            ipToInt(sip); ipToInt(sipMask); ipToInt(dip); ipToInt(dipMask);
        } catch (e) {
            showError('batch-error', `Line ${i + 1}: ${e.message}`);
            return;
        }
        parsed.push({ index: idx, sip, sipMask, dip, dipMask, action: act });
    }

    const indices = parsed.map(p => p.index);
    if (new Set(indices).size !== indices.length) {
        showError('batch-error', 'Batch contains duplicate indices');
        return;
    }

    let programmed = 0;
    const errors = [];
    for (const r of parsed) {
        try {
            const value = TCAM.packSipDip(ipToInt(r.sip), ipToInt(r.dip));
            const mask = TCAM.packSipDip(ipToInt(r.sipMask), ipToInt(r.dipMask));
            entry.tcam.program(r.index, value, mask, r.action);
            programmed++;
        } catch (e) {
            errors.push(`Index ${r.index}: ${e.message}`);
        }
    }

    entry.progHistory.unshift({
        timestamp: nowISO(),
        operation: 'batch',
        details: { programmed, errors: errors.length },
    });

    if (errors.length) {
        showError('batch-error', `${errors.length} failed: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
    }
    if (programmed > 0) {
        showNotice('batch-notice', `${programmed} entries programmed successfully`);
        $('batch-input').value = '';
    }
    saveToStorage();
    refreshDetail();
}

// ---------------------------------------------------------------------------
// Persistence (localStorage)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'tcamv2_state';

function saveToStorage() {
    const data = {};
    for (const [id, entry] of Object.entries(tcams)) {
        const t = entry.tcam;
        const entries = [];
        for (let i = 0; i < t.depth; i++) {
            const e = t.getEntry(i);
            entries.push({
                value: e.value.map(v => v.toString()),
                mask: e.mask.map(v => v.toString()),
                action: e.action,
                valid: e.valid,
            });
        }
        data[id] = {
            name: entry.name,
            id: entry.id,
            width: t.width,
            depth: t.depth,
            implicitDenyIndex: entry.implicitDenyIndex,
            entries,
            history: entry.history,
            progHistory: entry.progHistory,
        };
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
}

function loadFromStorage() {
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (_) { return; }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }

    for (const [id, d] of Object.entries(data)) {
        const t = new TCAM(d.width, d.depth);
        for (let i = 0; i < d.entries.length; i++) {
            const se = d.entries[i];
            const entry = t.getEntry(i);
            entry.value = se.value.map(v => BigInt(v));
            entry.mask = se.mask.map(v => BigInt(v));
            entry.action = se.action;
            entry.valid = se.valid;
        }
        tcams[id] = {
            tcam: t,
            name: d.name,
            id: d.id,
            implicitDenyIndex: d.implicitDenyIndex,
            history: d.history || [],
            progHistory: d.progHistory || [],
        };
    }
}

// ---------------------------------------------------------------------------
// Export / Import (JSON file)
// ---------------------------------------------------------------------------

function exportAll() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || Object.keys(tcams).length === 0) {
        alert('Nothing to export — create a TCAM first.');
        return;
    }
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tcamv2-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const data = JSON.parse(reader.result);
            if (typeof data !== 'object' || data === null) throw new Error('Invalid format');
            // Validate and load each TCAM
            let count = 0;
            for (const [id, d] of Object.entries(data)) {
                if (!d.width || !d.depth || !d.entries) continue;
                const t = new TCAM(d.width, d.depth);
                for (let i = 0; i < d.entries.length; i++) {
                    const se = d.entries[i];
                    const entry = t.getEntry(i);
                    entry.value = se.value.map(v => BigInt(v));
                    entry.mask = se.mask.map(v => BigInt(v));
                    entry.action = se.action;
                    entry.valid = se.valid;
                }
                tcams[id] = {
                    tcam: t,
                    name: d.name,
                    id: d.id || id,
                    implicitDenyIndex: d.implicitDenyIndex,
                    history: d.history || [],
                    progHistory: d.progHistory || [],
                };
                count++;
            }
            saveToStorage();
            loadList();
            alert(`Imported ${count} TCAM(s) successfully.`);
        } catch (e) {
            alert(`Import failed: ${e.message}`);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadFromStorage();
loadList();
