(function () {
    'use strict';

    // ─── 1. LER AS CONFIGURAÇÕES PASSADAS PELO TAMPERMONKEY ────────────────
    const userConfig = window.TW_DEFESA_CONFIG || {};

    const CONFIG = {
        webhookUrl: userConfig.webhookUrl || '',
        googleSheetsUrl: 'https://script.google.com/macros/s/AKfycbxJC3F4_uOKirSdmtNQf2itoHK8Y3xYurhou0Be2QtctFxVdhZIZP9GytsMPqg_raSl/exec',
        nunoFerrScriptUrl: 'https://nunoferr.github.io/TribalWars/Scripts/VillagesTroopsCounter/villagesTroopsCounter.js',
        rewardImages: [
            'https://i.imgur.com/iy8ZRn7.png',
            'https://i.imgur.com/yed5Zfk.gif',
            'https://cdn.boob.bot/ass/4FCE.GIF',
            'https://cdn.boob.bot/boobs/80003BF0.gif',            
        ],
    };

    if (!CONFIG.webhookUrl) {
        console.warn('Defesa Disponível: O Webhook do Discord não foi configurado no Tampermonkey!');
    }

    const ALL_UNITS = [
        'spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher',
        'heavy', 'ram', 'catapult', 'snob'
    ];

    const STATE = { isRunning: false, hooked: false, checkInterval: null };

    var STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48h

    // ─── COOKIES ──────────────────────────────────────────────────────────

    function setCookie(name, value, days) {
        var d = new Date();
        d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
        document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/';
    }

    function getCookie(name) {
        var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function getLastUpdated() {
        var val = getCookie('defesa_lastUpdated');
        return val ? parseInt(val, 10) : null;
    }

    function setLastUpdated() {
        setCookie('defesa_lastUpdated', String(Date.now()), 90);
    }

    function getStaleMessage(lastUpdated, now) {
        if (!lastUpdated) return 'Nunca enviaste a tua defesa.';

        var diffMs = now - lastUpdated;
        if (diffMs < 0) return 'Atualizado agora';

        var diffH = Math.floor(diffMs / (1000 * 60 * 60));
        var diffD = Math.floor(diffH / 24);

        if (diffMs >= STALE_THRESHOLD_MS) {
            if (diffD >= 2) return 'Defesa desatualizada (' + diffD + ' dias)!';
            return 'Defesa desatualizada (' + diffH + 'h)!';
        }

        if (diffH < 1) return 'Atualizado agora';
        if (diffH === 1) return 'Atualizado há 1h';
        return 'Atualizado há ' + diffH + 'h';
    }

    // ─── HELPERS ──────────────────────────────────────────────────────────

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Falha a carregar: ${src}`));
            document.head.appendChild(s);
        });
    }

    function getCurrentGroupName() {
        const popupSelect = window.jQuery('#popup_box_import select option:selected');
        if (popupSelect.length) {
            return popupSelect.text().trim();
        }
        return window.jQuery('strong.group-menu-item').text().trim();
    }

    // ─── WAIT FOR NUNOFERR POPUP TABLE ────────────────────────────────────

    function waitForPopupTable(timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const interval = setInterval(() => {
                const table = document.querySelector('#popup_box_import #support_sum');
                if (table) {
                    clearInterval(interval);
                    resolve(table);
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    reject(new Error('Timeout: a popup do contador não apareceu em 60s.'));
                }
            }, 500);
        });
    }

    // ─── SCRAPE TOTAL ROW FROM POPUP ──────────────────────────────────────

    function scrapeTroopsFromTable(table) {
        const $ = window.jQuery;

        const unitKeys = [];
        $(table).find('thead th a[data-unit]').each(function () {
            unitKeys.push($(this).attr('data-unit'));
        });

        if (unitKeys.length === 0) {
            throw new Error('Não encontrei unidades no cabeçalho da tabela.');
        }

        const totalRow = $(table).find('tbody tr').last();
        if (!totalRow.length) {
            throw new Error('Não encontrei a linha Total na tabela.');
        }

        const troops = {};
        $(totalRow).find('td[data-unit]').each(function () {
            const unit = $(this).attr('data-unit');
            const value = parseInt($(this).text().trim().replace(/\./g, '').replace(/,/g, ''), 10) || 0;
            troops[unit] = value;
        });

        if (Object.keys(troops).length === 0) {
            const tds = $(totalRow).find('td');
            unitKeys.forEach((unit, i) => {
                troops[unit] = parseInt($(tds[i + 1]).text().trim().replace(/\./g, '').replace(/,/g, ''), 10) || 0;
            });
        }

        return troops;
    }

    // ─── SCRAPE + INJECT (reusable) ───────────────────────────────────────

    function scrapeAndInjectDiscord() {
        const table = document.querySelector('#popup_box_import #support_sum');
        if (!table) return;

        try {
            const troops = scrapeTroopsFromTable(table);
            injectDiscordButton(troops);
        } catch (err) {
            console.error('Defesa Disponível - Erro ao re-injetar:', err);
        }
    }

    // ─── HOOK INTO NUNOFERR changeGroup ───────────────────────────────────

    function hookChangeGroup() {
        if (STATE.hooked) return;
        if (typeof window.villagesTroopsCounter === 'undefined') return;

        const original = window.villagesTroopsCounter.changeGroup.bind(window.villagesTroopsCounter);

        window.villagesTroopsCounter.changeGroup = function (obj) {
            original(obj);
            setTimeout(scrapeAndInjectDiscord, 800);
        };

        STATE.hooked = true;
    }

    // ─── PERIODIC CHECK (fallback) ────────────────────────────────────────

    function startPeriodicCheck() {
        if (STATE.checkInterval) return;

        STATE.checkInterval = setInterval(() => {
            const popup = document.querySelector('#popup_box_import');
            if (!popup) {
                clearInterval(STATE.checkInterval);
                STATE.checkInterval = null;
                return;
            }

            const table = popup.querySelector('#support_sum');
            const discordBtn = popup.querySelector('.discord-button-row');

            if (table && !discordBtn) {
                scrapeAndInjectDiscord();
            }
        }, 1500);
    }

    // ─── INJECT DISCORD BUTTON INTO POPUP ─────────────────────────────────

    function injectDiscordButton(troops) {
        const $ = window.jQuery;
        $('.discord-button-row').remove();

        const currentGroup = getCurrentGroupName();
        const playerName = window.game_data.player.name;
        const tribeName = window.game_data.player.ally || '(sem tribo)';

        const missingWebhookWarning = !CONFIG.webhookUrl 
            ? `<div style="margin-top:8px;font-weight:bold;color:#c0392b;">⚠️ ERRO: Adiciona o teu Webhook no script do Tampermonkey!</div>` 
            : '';

        const html = `
            <div class="discord-button-row" style="display:flex;flex-direction:column;align-items:center;gap:10px;margin:14px auto;">
                <div style="background:#f9f3e0;border:1px solid #d6c58a;border-radius:8px;padding:10px 14px;font-size:11px;color:#4a3513;width:90%;max-width:360px;">
                    <div style="font-weight:bold;margin-bottom:6px;">O que será enviado:</div>
                    <div title="O grupo selecionado no contador. Muda o grupo acima para enviar dados de outro grupo.">
                        <b>Grupo:</b> ${currentGroup || '<i>nenhum</i>'}
                    </div>
                    <div title="O teu nome de jogador, identificado automaticamente.">
                        <b>Jogador:</b> ${playerName}
                    </div>
                    <div title="A tua tribo atual. Os dados ficam separados por tribo na tabela.">
                        <b>Tribo:</b> ${tribeName}
                    </div>
                    <div title="Total de tropas da linha 'Total' do contador, para o grupo selecionado.">
                        <b>Tropas:</b> totais do grupo selecionado
                    </div>
                    <div style="margin-top:6px;font-style:italic;color:#7a6530;">
                        Os dados são enviados para o Discord e para a tabela da liderança.
                        Para atualizar outro grupo, muda o grupo no contador acima e clica novamente.
                    </div>
                    ${missingWebhookWarning}
                </div>
                <button id="sendDefesa" type="button"
                    style="padding:12px 28px;cursor:pointer;background:linear-gradient(to bottom,#f2e5b6,#d6c58a);border:1px solid #b59e4c;border-radius:10px;font-size:15px;font-weight:bold;color:#4a3513;text-shadow:0 1px 0 rgba(255,255,255,0.5);"
                    title="Envia as tropas totais do grupo selecionado para o Discord e para a tabela da liderança.">
                    Partilhar Defesa
                </button>
                <div id="defesaReward" style="display:none;text-align:center;">
                    <div style="font-size:13px;font-weight:bold;color:#27ae60;margin-bottom:8px;">
                        Obrigado por atualizares!
                    </div>
                    <img id="defesaRewardImg" src="" alt="Recompensa"
                        style="max-width:204px;max-height:204px;width:auto;height:auto;border-radius:10px;">
                </div>
            </div>
        `;

        const popup = $('#popup_box_import .popup_box_content');
        if (popup.length) {
            popup.append(html);
        }

        $('#sendDefesa').on('click', function () {
            if (!CONFIG.webhookUrl) {
                alert('Erro: Não configuraste o webhook no Tampermonkey!');
                return;
            }

            sendToDiscord(troops);
            
            if (CONFIG.googleSheetsUrl) {
                sendToGoogleSheets(troops);
            }

            setLastUpdated();
            updateLauncherStatus();
            $(this).prop('disabled', true).text('Enviado!');
            var img = CONFIG.rewardImages[Math.floor(Math.random() * CONFIG.rewardImages.length)];
            $('#defesaRewardImg').attr('src', img);
            $('#defesaReward').fadeIn(400);
        });
    }

    // ─── PAYLOAD BUILDERS ──────────────────────────────────────────────────

    function buildGoogleSheetsPayload(troops, playerName, groupName, tribeName) {
        var normalized = {};
        for (var i = 0; i < ALL_UNITS.length; i++) {
            normalized[ALL_UNITS[i]] = troops[ALL_UNITS[i]] || 0;
        }
        return {
            playerName: playerName,
            groupName: groupName,
            tribeName: tribeName,
            troops: normalized,
        };
    }

    function buildDiscordPayload(troops, playerName, groupName, tribeName) {
        // Ícones Corrigidos: Substituídos os IDs '0' por emojis universais
        var unitLabels = {
            spear:    { emoji: '<:lanceiro:1368839513891409972>',   name: 'Lanceiros' },
            sword:    { emoji: '<:espadachim:1368839514746785844>', name: 'Espadachins' },
            axe:      { emoji: '🪓',                                name: 'Guerreiros com Machado' },
            archer:   { emoji: '🏹',                                name: 'Arqueiros' },
            spy:      { emoji: '<:batedor:1368839512423137404>',   name: 'Batedores' },
            light:    { emoji: '🐎',                                name: 'Cavalaria Leve' },
            marcher:  { emoji: '🏇',                                name: 'Arqueiros a Cavalo' },
            heavy:    { emoji: '<:pesada:1368839517997498398>',    name: 'Cavalaria Pesada' },
            ram:      { emoji: '🪵',                                name: 'Arietes' },
            catapult: { emoji: '<:catapulta:1368839516441280573>',  name: 'Catapultas' },
            snob:     { emoji: '👑',                                name: 'Nobres' },
        };

        var fields = [
            { name: '\u{1F3F0} **Tribo**', value: tribeName || '-', inline: false },
            { name: '\u{1F5C2}\uFE0F **Grupo Atual**', value: groupName || '-', inline: false },
        ];
        
        for (var i = 0; i < ALL_UNITS.length; i++) {
            var u = ALL_UNITS[i];
            var label = unitLabels[u];
            fields.push({
                name: label.emoji + ' **' + label.name + '**',
                value: String(troops[u] || 0),
                inline: true,
            });
        }

        return {
            content: '**Tropas (Atualizado por:** ' + playerName + '**)**',
            embeds: [{
                title: '**\u{1F6E1}\uFE0F TROPAS**',
                color: 13948116, // Adiciona uma cor ao painel do Discord
                fields: fields,
            }],
        };
    }

    // ─── DISCORD SEND ─────────────────────────────────────────────────────

    function sendToDiscord(troops) {
        var playerName = window.game_data.player.name;
        var tribeName = window.game_data.player.ally || '';
        var currentGroup = getCurrentGroupName();
        var payload = buildDiscordPayload(troops, playerName, currentGroup, tribeName);

        window.jQuery.ajax({
            url: CONFIG.webhookUrl,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(payload),
            success: function () { console.log('Defesa enviada para Discord.'); },
            error: function () { console.warn('Erro ao enviar para Discord.'); },
        });
    }

    // ─── GOOGLE SHEETS SEND ───────────────────────────────────────────────

    function sendToGoogleSheets(troops) {
        var playerName = window.game_data.player.name;
        var tribeName = window.game_data.player.ally || '';
        var currentGroup = getCurrentGroupName();
        var payload = buildGoogleSheetsPayload(troops, playerName, currentGroup, tribeName);

        fetch(CONFIG.googleSheetsUrl, {
            method: 'POST',
            mode: 'no-cors',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload),
        })
        .then(function () { console.log('Defesa enviada para Google Sheets.'); })
        .catch(function () { console.warn('Erro ao enviar para Google Sheets.'); });
    }

    // ─── LAUNCHER BUTTON ──────────────────────────────────────────────────

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #tmDefesaLauncher {
                position: fixed; right: 18px; bottom: 18px; z-index: 99999;
                min-width: 190px; min-height: 60px; padding: 14px 20px;
                background: linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0) 36%),
                    linear-gradient(to bottom, #f6e8bc 0%, #d7bf82 55%, #c3a15f 100%);
                border: 1px solid #8b6a2c; border-radius: 14px;
                color: #4a3513; font-size: 21px; font-weight: bold;
                text-shadow: 0 1px 0 rgba(255,255,255,0.6);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), 0 8px 18px rgba(54,35,7,0.32);
                cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 10px;
                transition: transform 0.18s ease, box-shadow 0.18s ease;
            }
            #tmDefesaLauncher:hover {
                background: linear-gradient(180deg, rgba(255,255,255,0.3), rgba(255,255,255,0) 36%),
                    linear-gradient(to bottom, #faefc9 0%, #e0c98f 55%, #cba968 100%);
                transform: translateY(-2px);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 12px 22px rgba(54,35,7,0.36);
            }
            #tmDefesaLauncher:disabled { opacity: 0.6; cursor: wait; transform: none; }
            #tmDefesaLauncher.stale {
                border-color: #c0392b;
                animation: defesaPulse 2.5s ease-in-out infinite;
            }
            @keyframes defesaPulse {
                0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), 0 8px 18px rgba(54,35,7,0.32); }
                50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), 0 0 18px 4px rgba(192,57,43,0.45); }
            }
            #tmDefesaStatus {
                font-size: 10px; font-weight: normal; opacity: 0.85;
                display: block; margin-top: 2px;
            }
        `;
        document.head.appendChild(style);
    }

    function renderLauncherButton() {
        if (document.getElementById('tmDefesaLauncher')) return;

        const btn = document.createElement('button');
        btn.id = 'tmDefesaLauncher';
        btn.type = 'button';
        btn.innerHTML = '<span style="font-size:22px;">&#128737;&#65039;</span><span><span id="tmDefesaLabel">Abrir Defesa</span><span id="tmDefesaStatus"></span></span>';

        btn.addEventListener('click', async () => {
            if (STATE.isRunning) return;
            STATE.isRunning = true;
            setButtonState(true);

            try {
                if (typeof window.villagesTroopsCounter === 'undefined') {
                    await loadScript(CONFIG.nunoFerrScriptUrl);
                } else {
                    window.villagesTroopsCounter.init();
                }

                const table = await waitForPopupTable();
                await new Promise(r => setTimeout(r, 500));

                const troops = scrapeTroopsFromTable(table);
                injectDiscordButton(troops);

                // Hook into changeGroup for future group changes
                hookChangeGroup();

                // Fallback: periodic check
                startPeriodicCheck();

            } catch (err) {
                console.error('Defesa Disponível Error:', err);
                window.UI?.ErrorMessage?.(err.message || 'Erro inesperado!');
            } finally {
                STATE.isRunning = false;
                setButtonState(false);
            }
        });

        document.body.appendChild(btn);
        updateLauncherStatus();
    }

    function updateLauncherStatus() {
        const btn = document.getElementById('tmDefesaLauncher');
        const status = document.getElementById('tmDefesaStatus');
        if (!btn || !status) return;

        const lastUpdated = getLastUpdated();
        const now = Date.now();
        const isStale = !lastUpdated || (now - lastUpdated) >= STALE_THRESHOLD_MS;

        status.textContent = getStaleMessage(lastUpdated, now);
        btn.classList.toggle('stale', isStale);
    }

    function setButtonState(running) {
        const label = document.getElementById('tmDefesaLabel');
        const btn = document.getElementById('tmDefesaLauncher');
        if (!btn || !label) return;
        btn.disabled = running;
        label.textContent = running ? 'A correr...' : 'Abrir Defesa';
    }

    // ─── MAIN ─────────────────────────────────────────────────────────────

    function main() {
        if (window.top !== window.self) return;
        if (typeof window.jQuery === 'undefined' || typeof window.game_data === 'undefined') return;
        injectStyles();
        renderLauncherButton();
    }

    main();
})();
