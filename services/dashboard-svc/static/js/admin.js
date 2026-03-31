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
loadMarketRegistry();

// ── Market Registry Panel ───────────────────────────────────────────────

const COUNTRY_FLAGS = {
    'America/New_York': '🇺🇸', 'Asia/Seoul': '🇰🇷', 'Asia/Shanghai': '🇨🇳',
    'Europe/Madrid': '🇪🇸', 'Europe/London': '🇬🇧', 'Asia/Tokyo': '🇯🇵',
    'Pacific/Auckland': '🇳🇿',
};

let allMarkets = [];

async function loadMarketRegistry() {
    try {
        // Fetch ALL markets including inactive for admin view
        const res = await fetch('/api/markets/all');
        allMarkets = await res.json();
        renderMarketRegistry(allMarkets);
    } catch (err) {
        document.getElementById('marketRegistryRoot').innerHTML =
            '<div class="section"><div class="section-header"><span class="section-icon">⚠️</span><span class="section-title">Failed to load market registry</span></div></div>';
    }
}

async function createMarket(data) {
    try {
        const res = await fetch('/api/markets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (res.ok || res.status === 201) {
            toast('Market "' + data.id + '" created!');
            await loadMarketRegistry();
        } else {
            const err = await res.json().catch(() => ({}));
            toast('Failed: ' + (err.error || res.status), 'error');
        }
    } catch (err) {
        toast('Network error: ' + err.message, 'error');
    }
}

async function saveMarketField(marketId, field, value) {
    try {
        const res = await fetch('/api/markets/' + marketId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
        });
        if (res.ok) {
            const updated = await res.json();
            const idx = allMarkets.findIndex(m => m.id === marketId);
            if (idx !== -1) allMarkets[idx] = updated;
            renderMarketRegistry(allMarkets);
            toast('Updated ' + marketId + '.' + field);
        } else {
            toast('Failed: ' + (await res.text()), 'error');
        }
    } catch (err) {
        toast('Network error: ' + err.message, 'error');
    }
}

function renderMarketRegistry(markets) {
    const root = document.getElementById('marketRegistryRoot');
    if (!markets || markets.length === 0) {
        root.innerHTML = '';
        return;
    }

    const FIELDS = [
        { key: 'station_name', label: 'Weather Station', desc: 'ICAO code (e.g. KLGA, EGLL)', width: '100px' },
        { key: 'station_lat',  label: 'Latitude',        desc: 'Station lat coordinate',      width: '100px', type: 'number' },
        { key: 'station_lon',  label: 'Longitude',       desc: 'Station lon coordinate',      width: '100px', type: 'number' },
        { key: 'unit',         label: 'Unit',             desc: 'Temperature unit',            width: '60px',  choices: ['F', 'C'] },
        { key: 'daily_budget', label: 'Daily Budget ($)', desc: 'Per-market daily spend cap',  width: '80px',  type: 'number' },
        { key: 'timezone',     label: 'Timezone',         desc: 'IANA timezone',               width: '180px' },
        { key: 'slug_template', label: 'Polymarket Slug', desc: 'URL slug template ({date} replaced)', width: '320px' },
    ];

    let html = '<div class="section">';
    html += '<div class="section-header">';
    html += '<span class="section-icon">🌍</span>';
    html += '<span class="section-title">Market Registry — Weather Alignment</span>';
    html += '<span class="section-count">' + markets.length + ' markets</span>';
    html += '</div>';

    html += '<div class="market-registry-grid">';
    for (const m of markets) {
        const flag = COUNTRY_FLAGS[m.timezone] || '🌐';
        const isActive = m.active === 1 || m.active === true;

        html += '<div class="market-card' + (isActive ? '' : ' market-inactive') + '" data-market-id="' + m.id + '">';
        html += '<div class="market-card-header">';
        html += '<div class="market-card-title">';
        html += '<span class="market-flag">' + flag + '</span>';
        html += '<span class="market-name">' + esc(m.name || m.id) + '</span>';
        html += '<span class="market-id">' + m.id + '</span>';
        html += '</div>';
        html += '<label class="market-toggle">';
        html += '<input type="checkbox" class="market-active-toggle" data-market-id="' + m.id + '"' + (isActive ? ' checked' : '') + '>';
        html += '<span class="toggle-slider"></span>';
        html += '<span class="toggle-label">' + (isActive ? 'Active' : 'Inactive') + '</span>';
        html += '</label>';
        html += '</div>';

        html += '<div class="market-fields">';
        for (const f of FIELDS) {
            const val = m[f.key] ?? '';
            const fieldId = 'mkt__' + m.id + '__' + f.key;

            html += '<div class="market-field">';
            html += '<label class="market-field-label" for="' + fieldId + '">' + f.label + '</label>';

            if (f.choices) {
                html += '<div class="market-field-input-row">';
                html += '<select class="market-field-input" id="' + fieldId + '" data-market-id="' + m.id + '" data-field="' + f.key + '" data-original="' + esc(String(val)) + '" style="width:' + f.width + '">';
                for (const c of f.choices) {
                    html += '<option value="' + c + '"' + (String(c) === String(val) ? ' selected' : '') + '>' + c + '</option>';
                }
                html += '</select>';
                html += '</div>';
            } else {
                html += '<div class="market-field-input-row">';
                html += '<input class="market-field-input" id="' + fieldId + '" value="' + esc(String(val)) + '" ';
                html += 'data-market-id="' + m.id + '" data-field="' + f.key + '" data-original="' + esc(String(val)) + '" ';
                if (f.type) html += 'type="' + f.type + '" step="any" ';
                html += 'style="width:' + f.width + '" />';
                html += '<button class="market-field-save" data-input-id="' + fieldId + '">Save</button>';
                html += '</div>';
            }

            if (f.desc) html += '<div class="market-field-desc">' + f.desc + '</div>';
            html += '</div>';
        }
        html += '</div>';
        html += '</div>';
    }
    html += '</div>';

    // ── Add Market Form ──────────────────────────────────────────────
    html += '<div class="add-market-form">';
    html += '<div class="add-market-title">➕ Add New Market</div>';
    html += '<div class="add-market-fields">';
    html += '<div class="add-market-field"><label>Market ID</label><input id="new_mkt_id" placeholder="e.g. paris" /></div>';
    html += '<div class="add-market-field"><label>City Name</label><input id="new_mkt_name" placeholder="e.g. Paris" /></div>';
    html += '<div class="add-market-field"><label>Station (ICAO)</label><input id="new_mkt_station" placeholder="e.g. LFPG" /></div>';
    html += '<div class="add-market-field"><label>Latitude</label><input id="new_mkt_lat" type="number" step="any" placeholder="48.8566" /></div>';
    html += '<div class="add-market-field"><label>Longitude</label><input id="new_mkt_lon" type="number" step="any" placeholder="2.3522" /></div>';
    html += '<div class="add-market-field"><label>Unit</label><select id="new_mkt_unit"><option value="C">C</option><option value="F">F</option></select></div>';
    html += '<div class="add-market-field"><label>Timezone</label><input id="new_mkt_tz" placeholder="Europe/Paris" /></div>';
    html += '<div class="add-market-field add-market-btn-wrap"><button class="btn-add-market" id="btnAddMarket">Add Market</button></div>';
    html += '</div></div>';

    html += '</div>';

    root.innerHTML = html;

    // Event delegation for market registry
    root.addEventListener('input', function(e) {
        const input = e.target.closest('.market-field-input');
        if (!input || input.tagName === 'SELECT') return;
        const isChanged = input.value !== input.dataset.original;
        input.classList.toggle('changed', isChanged);
        const saveBtn = root.querySelector('.market-field-save[data-input-id="' + input.id + '"]');
        if (saveBtn) saveBtn.classList.toggle('visible', isChanged);
    });

    root.addEventListener('change', function(e) {
        if (e.target.tagName === 'SELECT' && e.target.classList.contains('market-field-input')) {
            const sel = e.target;
            if (sel.value !== sel.dataset.original) {
                saveMarketField(sel.dataset.marketId, sel.dataset.field, sel.value);
            }
        }
        if (e.target.classList.contains('market-active-toggle')) {
            const cb = e.target;
            saveMarketField(cb.dataset.marketId, 'active', cb.checked ? 1 : 0);
        }
    });

    root.addEventListener('keydown', function(e) {
        const input = e.target.closest('.market-field-input');
        if (input && e.key === 'Enter' && input.value !== input.dataset.original) {
            let val = input.value;
            if (input.type === 'number') val = parseFloat(val);
            saveMarketField(input.dataset.marketId, input.dataset.field, val);
        }
    });

    root.addEventListener('click', function(e) {
        const saveBtn = e.target.closest('.market-field-save');
        if (saveBtn) {
            const input = document.getElementById(saveBtn.dataset.inputId);
            if (input && input.value !== input.dataset.original) {
                let val = input.value;
                if (input.type === 'number') val = parseFloat(val);
                saveMarketField(input.dataset.marketId, input.dataset.field, val);
            }
        }

        // Add Market button
        if (e.target.id === 'btnAddMarket' || e.target.closest('#btnAddMarket')) {
            const id = document.getElementById('new_mkt_id')?.value?.trim();
            const name = document.getElementById('new_mkt_name')?.value?.trim();
            if (!id || !name) {
                toast('Market ID and City Name are required', 'warning');
                return;
            }
            createMarket({
                id,
                name,
                station_name: document.getElementById('new_mkt_station')?.value?.trim() || '',
                station_lat: document.getElementById('new_mkt_lat')?.value || 0,
                station_lon: document.getElementById('new_mkt_lon')?.value || 0,
                unit: document.getElementById('new_mkt_unit')?.value || 'C',
                timezone: document.getElementById('new_mkt_tz')?.value?.trim() || 'UTC',
            });
        }
    });
}
