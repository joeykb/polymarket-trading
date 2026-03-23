/**
 * TempEdge Admin — Client-side JavaScript
 */

const SECTION_META = {
    trading: { icon: '💰', label: 'Trading & Risk' },
    monitor: { icon: '👁️', label: 'Monitoring Thresholds' },
    liquidity: { icon: '📡', label: 'Liquidity Streaming' },
    weather: { icon: '🌤️', label: 'Weather Service' },
    polymarket: { icon: '📈', label: 'Polymarket API' },
    dashboard: { icon: '📊', label: 'Dashboard' },
    phases: { icon: '🔄', label: 'Phase Logic' },
};

let currentConfig = {};

function toast(message, type = 'success') {
    const container = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

async function loadConfig() {
    const res = await fetch('/api/config?admin=1');
    const data = await res.json();
    currentConfig = data.config;
    render(currentConfig);
}

async function saveValue(section, field, value) {
    try {
        const res = await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [section]: { [field]: value } }),
        });
        const data = await res.json();
        if (data.success) {
            currentConfig = data.config;
            render(currentConfig);
            if (data.applied?.length > 0) toast('Saved: ' + data.applied.join(', '));
            if (data.requiresRestart?.length > 0) toast('⚠️ Restart required for: ' + data.requiresRestart.join(', '), 'warning');
            if (data.skipped?.length > 0) toast('Skipped: ' + data.skipped.join(', '), 'warning');
        } else {
            toast('Error: ' + (data.error || 'Unknown'), 'error');
        }
    } catch (err) {
        toast('Network error: ' + err.message, 'error');
    }
}

async function resetValue(section, field) {
    try {
        const res = await fetch('/api/config/reset/' + section + '/' + field, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            currentConfig = data.config;
            render(currentConfig);
            toast('Reset ' + section + '.' + field + ' to default');
        }
    } catch (err) {
        toast('Reset failed: ' + err.message, 'error');
    }
}

async function resetAll() {
    if (!confirm('Reset ALL config overrides back to defaults? This cannot be undone.')) return;
    try {
        const res = await fetch('/api/config/reset', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            currentConfig = data.config;
            render(currentConfig);
            toast('All overrides reset to defaults');
        }
    } catch (err) {
        toast('Reset failed: ' + err.message, 'error');
    }
}

async function restartService() {
    if (!confirm('Restart the TempEdge monitor service?\nThe monitor will save sessions and restart within a few seconds.')) return;
    try {
        const res = await fetch('/api/restart', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            toast('Restart signal sent — monitor will restart within 5 seconds', 'info');
        } else {
            toast('Restart failed: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        toast('Restart failed: ' + err.message, 'error');
    }
}

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render(cfg) {
    const root = document.getElementById('configRoot');
    let html = '';

    for (const [section, fields] of Object.entries(cfg)) {
        const meta = SECTION_META[section] || { icon: '📋', label: section };
        const count = Object.keys(fields).length;

        html += '<div class="section">';
        html += '<div class="section-header">';
        html += '<span class="section-icon">' + meta.icon + '</span>';
        html += '<span class="section-title">' + meta.label + '</span>';
        html += '<span class="section-count">' + count + ' settings</span>';
        html += '</div>';
        html += '<div class="config-grid">';

        for (const [field, info] of Object.entries(fields)) {
            const id = section + '__' + field;
            const isLocked = info.lockedByEnv || info.readOnly;
            const isOverride = info.source === 'override';
            const cls = isLocked ? 'locked' : isOverride ? 'modified' : '';

            html += '<div class="config-item ' + cls + '">';
            html += '<div class="config-item-header">';
            html += '<span class="config-key">' + esc(info.envKey) + '</span>';
            html += '<div class="config-badges">';
            if (info.requiresRestart) html += '<span class="badge badge-restart">restart</span>';
            if (info.sensitive) html += '<span class="badge badge-locked">🔒</span>';
            if (info.source === 'env') html += '<span class="badge badge-env">ENV</span>';
            else if (info.source === 'override') html += '<span class="badge badge-override">OVERRIDE</span>';
            else html += '<span class="badge badge-default">DEFAULT</span>';
            html += '</div></div>';

            if (info.description) {
                html += '<div class="config-desc">' + esc(info.description) + '</div>';
            }

            html += '<div class="config-input-row">';

            if (info.choices && info.choices.length > 0 && !isLocked) {
                // Dropdown for fields with defined choices
                html += '<select class="config-input" id="' + id + '" ';
                html += 'data-section="' + section + '" ';
                html += 'data-field="' + field + '" ';
                html += 'data-original="' + esc(String(info.value)) + '">';
                for (let ci = 0; ci < info.choices.length; ci++) {
                    const cv = info.choices[ci];
                    const selected = String(cv) === String(info.value) ? ' selected' : '';
                    let choiceLabel = cv;
                    // Friendly labels for boolean choices
                    if (info.choices.length === 2 && info.choices[0] === 0 && info.choices[1] === 1) {
                        choiceLabel = cv === 0 ? '0 — Off' : '1 — On';
                    }
                    html += '<option value="' + esc(String(cv)) + '"' + selected + '>' + esc(String(choiceLabel)) + '</option>';
                }
                html += '</select>';
            } else {
                // Standard text input
                html += '<input class="config-input" id="' + id + '" ';
                html += 'value="' + esc(String(info.value)) + '" ';
                if (isLocked) html += 'disabled ';
                html += 'data-section="' + section + '" ';
                html += 'data-field="' + field + '" ';
                html += 'data-original="' + esc(String(info.value)) + '" ';
                html += '/>';
            }

            if (!isLocked) {
                html += '<button class="btn-save" id="save_' + id + '" data-input-id="' + id + '">Save</button>';
            }
            if (isOverride && !isLocked) {
                html +=
                    '<button class="btn-reset-val visible" data-reset-section="' +
                    section +
                    '" data-reset-field="' +
                    field +
                    '">↺</button>';
            }

            html += '</div>';

            if (info.source !== 'default' && info.default !== '(hidden)') {
                html += '<div class="config-default">default: ' + esc(String(info.default)) + '</div>';
            }

            html += '</div>';
        }

        html += '</div></div>';
    }

    root.innerHTML = html;

    // Event delegation
    root.addEventListener('input', function (e) {
        if (e.target.classList.contains('config-input')) {
            const el = e.target;
            const isChanged = el.value !== el.dataset.original;
            el.classList.toggle('changed', isChanged);
            const saveBtn = document.getElementById('save_' + el.id);
            if (saveBtn) saveBtn.classList.toggle('visible', isChanged);
        }
    });

    // Auto-save on select change (dropdowns)
    root.addEventListener('change', function (e) {
        if (e.target.tagName === 'SELECT' && e.target.classList.contains('config-input')) {
            const el = e.target;
            if (el.value !== el.dataset.original) {
                saveValue(el.dataset.section, el.dataset.field, el.value);
            }
        }
    });

    root.addEventListener('keydown', function (e) {
        if (e.target.classList.contains('config-input') && e.key === 'Enter') {
            const el = e.target;
            if (el.value !== el.dataset.original) {
                saveValue(el.dataset.section, el.dataset.field, el.value);
            }
        }
    });

    root.addEventListener('click', function (e) {
        const saveBtn = e.target.closest('.btn-save');
        if (saveBtn) {
            const inputId = saveBtn.dataset.inputId;
            const inputEl = document.getElementById(inputId);
            if (inputEl && inputEl.value !== inputEl.dataset.original) {
                saveValue(inputEl.dataset.section, inputEl.dataset.field, inputEl.value);
            }
            return;
        }
        const resetBtn = e.target.closest('.btn-reset-val');
        if (resetBtn) {
            resetValue(resetBtn.dataset.resetSection, resetBtn.dataset.resetField);
            return;
        }
    });
}

// Initial load
loadConfig();
