// custom.js - Versão Final Polida v5.0
// Correções: cache pré-carregado, login customizado, logo 3A, tratamento de nulos e erro "atm" do mapa
(function () {
  'use strict';
  console.log("=== Traccar Custom J16 v5.0 Final ===");

  // ─── EVITAR ERRO DE IMAGEM DO MAPA (ex: "atm", "sports_centre") ──────────
  // PROBLEMA RAIZ: maplibregl é carregado por index-mpix2PMe.js ANTES do custom.js.
  // O defineProperty antigo iniciava _lib = undefined, então o setter nunca disparava
  // para o valor já existente — o listener nunca era adicionado.
  // PROBLEMA SECUNDÁRIO: o handler interno "mse" do MapLibre não tem proteção anti-loop:
  //   addImage → _afterImageUpdated → _render → styleimagemissing → addImage → ...
  // SOLUÇÃO: capturar valor existente imediatamente + tornar addImage idempotente.

  function patchMapLib(lib) {
    if (!lib || !lib.Map || lib.Map.__j16patched) return;
    const OriginalMap = lib.Map;

    function PatchedMap(...args) {
      // Instanciar o mapa real
      const map = new OriginalMap(...args);

      // Tornar addImage idempotente para quebrar loop do mse interno:
      // addImage → _afterImageUpdated → re-render → styleimagemissing → addImage (já existe → no-op)
      const _origAddImage = map.addImage.bind(map);
      map.addImage = function(id, ...rest) {
        try {
          if (map.hasImage && map.hasImage(id)) return map; // já existe → sair sem re-render
        } catch (_) {}
        return _origAddImage(id, ...rest);
      };

      // Nosso handler de imagem ausente — com Set para deduplicação
      const _handled = new Set();
      map.on('styleimagemissing', (e) => {
        if (_handled.has(e.id)) return; // bloquear re-entradas
        _handled.add(e.id);
        try {
          if (!map.hasImage(e.id)) {
            // Imagem 1×1 transparente — mínimo impacto visual
            map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
          }
        } catch (_) { /* silencioso */ }
      });

      return map;
    }

    PatchedMap.__j16patched = true;
    PatchedMap.prototype = OriginalMap.prototype;
    try { Object.assign(PatchedMap, OriginalMap); } catch (_) {}
    lib.Map = PatchedMap;
    console.log('[J16] maplibregl/mapboxgl.Map patcheado com sucesso.');
  }

  function hookMapLib(libName) {
    // 1. Aplicar imediatamente se já estiver carregado
    if (window[libName]) {
      patchMapLib(window[libName]);
      return;
    }
    // 2. Interceptar atribuição futura (caso carregue depois)
    let _captured = undefined;
    try {
      Object.defineProperty(window, libName, {
        configurable: true,
        get() { return _captured; },
        set(val) {
          _captured = val;
          patchMapLib(val);
          // Converter de volta a propriedade simples após capturar
          try {
            delete window[libName];
            window[libName] = val;
          } catch (_) {}
        }
      });
    } catch (_) {}
  }

  hookMapLib('maplibregl');
  hookMapLib('mapboxgl');



  // ─── CACHE E LOGGER GLOBAL DO SISTEMA ────────────────────────────────────
  window.traccarCache = { devices: {}, positions: {} };
  
  // Fila de logs do sistema para depuração (limite de 100 logs na memória)
  const _systemLogs = [];
  function addSystemLog(msg, type = 'info') {
    const t = new Date().toLocaleTimeString('pt-BR');
    _systemLogs.push({ time: t, message: msg, type });
    if (_systemLogs.length > 100) _systemLogs.shift();
    renderSystemLogs();
  }

  function renderSystemLogs() {
    const div = document.getElementById('sys-logs');
    if (!div || div.style.display === 'none') return;
    div.innerHTML = '';
    const colors = { info: '#cbd5e1', error: '#f43f5e', warn: '#fb923c', success: '#4ade80' };
    _systemLogs.forEach(log => {
      const line = document.createElement('div');
      line.style.marginBottom = '4px';
      line.innerHTML = `<span style="color:#64748b">[${log.time}]</span> <span style="color:${colors[log.type] || '#fff'}">${log.message}</span>`;
      div.appendChild(line);
    });
    div.scrollTop = div.scrollHeight;
  }

  // Interceptar erros globais de Javascript (Erro de Implementação)
  window.addEventListener('error', (e) => {
    // Ignorar erros vindos de extensões ou externos não relevantes
    if (e.message && !e.message.includes('ResizeObserver')) {
      addSystemLog(`Erro JS: ${e.message} em ${e.filename?.split('/').pop() || 'script'}:${e.lineno}`, 'error');
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    addSystemLog(`Promise Rejeitada: ${e.reason}`, 'error');
  });

  // ─── POSITIONS SANITIZATION (Tratamento de Nulos) ──────────────────────────
  // Nota: o erro "Expected value to be of type number, but found null" vem do
  // worker interno do MapLibre ao processar tiles vetoriais do OSM — está FORA
  // do nosso código e não pode ser interceptado aqui. Cobrimos apenas os dados
  // de posição que usamos nos cards.
  function sanitizePosition(p) {
    if (!p) return;
    const n = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? 0 : Number(v);
    p.speed    = n(p.speed);
    p.course   = n(p.course);
    p.altitude = n(p.altitude);
    p.latitude = n(p.latitude);
    p.longitude = n(p.longitude);
    // Sanitizar atributos aninhados da posição (odômetro, horas etc. podem ser null)
    if (p.attributes && typeof p.attributes === 'object') {
      const a = p.attributes;
      if (a.odometer === null || a.odometer === undefined) a.odometer = 0;
      if (a.hours    === null || a.hours    === undefined) a.hours    = 0;
      if (a.distance === null || a.distance === undefined) a.distance = 0;
      if (a.totalDistance === null || a.totalDistance === undefined) a.totalDistance = 0;
      if (a.motion  === null || a.motion   === undefined) a.motion   = false;
    }
  }

  // ─── PRÉ-CARREGAR DEVICES E POSITIONS NO INÍCIO ───────────────────────────
  async function preloadCache() {
    try {
      const [dr, pr] = await Promise.all([
        fetch('/api/devices'),
        fetch('/api/positions')
      ]);
      if (dr.ok) {
        const devs = await dr.json();
        devs.forEach(d => { window.traccarCache.devices[d.id] = d; });
        console.log(`[J16] ${devs.length} devices carregados no cache`);
      }
      if (pr.ok) {
        const poss = await pr.json();
        poss.forEach(p => {
          sanitizePosition(p);
          window.traccarCache.positions[p.deviceId] = p;
        });
        console.log(`[J16] ${poss.length} posições carregadas no cache`);
      }
      // Após carregar, renderizar cards
      customCards();
    } catch (e) {
      console.warn('[J16] Pré-carga falhou (usuário ainda não logado):', e.message);
    }
  }

  // ─── INTERCEPTAR FETCH ────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (url, opts) {
    // Salvar atributos customizados antes de enviar cadastro de device
    if (typeof url === 'string' && url.includes('/api/devices') && opts &&
      (opts.method === 'POST' || opts.method === 'PUT')) {
      try {
        const payload = JSON.parse(opts.body);
        payload.attributes = payload.attributes || {};
        const g = (id) => document.getElementById(id)?.value ?? '';
        const gb = (id) => document.getElementById(id)?.checked ?? false;
        const photo = document.getElementById('j16-preview-photo-img')?.src ?? '';
        Object.assign(payload.attributes, {
          vehicleDescription: g('j16-in-desc'),
          vehicleModel: g('j16-in-model'),
          vehicleBrand: g('j16-in-brand'),
          vehicleYear: g('j16-in-year'),
          isPrimaryVehicle: gb('j16-in-primary'),
          equipmentStatus: g('j16-in-equip-status'),
          deviceImei: g('j16-in-imei'),
          simNumber: g('j16-in-sim'),
          vehicleGroupLabel: g('j16-in-group'),
          vehicleIconVariant: g('j16-in-icon-variant'),
        });
        if (photo.startsWith('data:image/')) payload.attributes.vehiclePhoto = photo;
        if (payload.attributes.vehicleModel) payload.model = payload.attributes.vehicleModel;
        opts.body = JSON.stringify(payload);
      } catch (e) { /* silencioso */ }
    }

    let res;
    try {
      res = await _fetch.apply(this, arguments);
    } catch (e) {
      addSystemLog(`Erro de Rede (fetch): ${e.message} ao chamar ${typeof url === 'string' ? url.split('?')[0] : 'API'}`, 'error');
      throw e;
    }

    if (typeof url === 'string') {
      const cleanUrl = url.split('?')[0];
      if (!res.ok) {
        // Ignorar 404 de /api/session pois é o comportamento nativo do Traccar para redirecionar ao Login
        if (!(cleanUrl.includes('/api/session') && res.status === 404)) {
          addSystemLog(`Erro HTTP ${res.status}: ${res.statusText} em ${cleanUrl}`, 'warn');
        }
      } else {
        try {
          if (url.includes('/api/devices') && (!opts || !opts.method || opts.method === 'GET')) {
            res.clone().json().then(arr => {
              if (!Array.isArray(arr)) return;
              arr.forEach(d => { window.traccarCache.devices[d.id] = d; });
            }).catch(() => {});
          }
          if (url.includes('/api/positions')) {
            res.clone().json().then(arr => {
              if (!Array.isArray(arr)) return;
              arr.forEach(p => {
                sanitizePosition(p);
                window.traccarCache.positions[p.deviceId] = p;
              });
            }).catch(() => {});
          }
        } catch (e) { /* silencioso */ }
      }
    }
    return res;
  };

  // ─── INTERCEPTAR WEBSOCKET ────────────────────────────────────────────────
  const _WS = window.WebSocket;
  window.WebSocket = function (url, proto) {
    const ws = new _WS(url, proto);
    ws.addEventListener('message', (evt) => {
      try {
        const d = JSON.parse(evt.data);
        let needsRefresh = false;
        if (d.devices) {
          d.devices.forEach(dev => { window.traccarCache.devices[dev.id] = dev; });
          needsRefresh = true;
        }
        if (d.positions) {
          d.positions.forEach(pos => {
            sanitizePosition(pos);
            window.traccarCache.positions[pos.deviceId] = pos;
          });
          needsRefresh = true;
        }
        // Re-renderizar cards quando chegar atualização do WS
        if (needsRefresh) scheduleRefresh();
      } catch (e) { /* silencioso */ }
    });
    return ws;
  };

  // ─── ESTILOS ──────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    /* ---- Login Wrapper ---- */
    #j16-login-wrapper {
      position: fixed; inset: 0; z-index: 9999999;
      background: #020617; display: flex; align-items: center; justify-content: center;
      font-family: 'Inter', 'Outfit', sans-serif;
    }
    .j16-login-container {
      width: 100vw; height: 100vh; display: grid; grid-template-columns: 1fr;
    }
    @media (min-width: 768px) {
      .j16-login-container { grid-template-columns: 1.15fr 0.85fr; }
    }
    .j16-login-banner {
      background: radial-gradient(circle at 20% 30%, #0f172a, #020617);
      color: #fff; padding: 50px; display: flex; flex-direction: column;
      justify-content: space-between; position: relative; overflow: hidden;
      border-right: 1px solid #1e293b; box-sizing: border-box;
    }
    .j16-login-banner::before {
      content: ''; position: absolute; inset: 0; opacity: 0.04;
      background-image: linear-gradient(to right, #ffffff 1px, transparent 1px),
                        linear-gradient(to bottom, #ffffff 1px, transparent 1px);
      background-size: 40px 40px; pointer-events: none;
    }
    .j16-login-banner-content { max-width: 550px; margin: auto 0; z-index: 2; }
    .j16-login-logo { margin-bottom: 25px; }
    .j16-login-title { font-size: 2.1rem; font-weight: 800; margin: 0 0 10px; color: #fff; letter-spacing: -0.5px; }
    .j16-login-subtitle { font-size: 0.95rem; color: #94a3b8; line-height: 1.6; margin: 0 0 35px; }
    
    .j16-login-features { display: flex; flex-direction: column; gap: 18px; margin-bottom: 35px; }
    .j16-feature-item { display: flex; align-items: center; gap: 14px; }
    .j16-feature-icon {
      font-size: 1.2rem; background: rgba(245, 158, 11, 0.08);
      width: 44px; height: 44px; display: flex; align-items: center;
      justify-content: center; border-radius: 10px; border: 1.5px solid rgba(245, 158, 11, 0.18);
      flex-shrink: 0;
    }
    .j16-feature-item strong { display: block; font-size: 0.9rem; color: #fff; margin-bottom: 1px; }
    .j16-feature-item p { margin: 0; font-size: 0.78rem; color: #94a3b8; }
    
    .j16-cache-alert {
      background: rgba(245, 158, 11, 0.06); border: 1.5px solid rgba(245, 158, 11, 0.22);
      border-radius: 10px; padding: 12px 16px; display: flex; gap: 12px; align-items: flex-start;
      margin-top: 15px; box-sizing: border-box;
    }
    .j16-alert-icon { font-size: 1.25rem; margin-top: 1px; flex-shrink: 0; }
    .j16-cache-alert p { margin: 0; font-size: 0.78rem; color: #cbd5e1; line-height: 1.5; }
    .j16-cache-alert kbd {
      background: #1e293b; border: 1px solid #475569; border-radius: 4px;
      padding: 1px 5px; font-size: 0.72rem; font-family: monospace; color: #f59e0b;
      box-shadow: 0 1px 0 rgba(0,0,0,0.2);
    }
    
    .j16-login-footer { font-size: 0.75rem; color: #475569; z-index: 2; }
    .j16-login-form-side {
      background: #090d16; display: flex; align-items: center; justify-content: center; padding: 40px; box-sizing: border-box;
    }
    .j16-login-form-box { width: 100%; max-width: 380px; }
    .j16-form-title { font-size: 1.5rem; font-weight: 800; color: #fff; margin: 0 0 6px; }
    .j16-form-desc { font-size: 0.82rem; color: #64748b; margin: 0 0 30px; }
    .j16-form-field { margin-bottom: 18px; }
    .j16-form-field label { display: block; font-size: 0.78rem; font-weight: 700; color: #94a3b8; margin-bottom: 6px; }
    .j16-input-icon-wrapper { position: relative; display: flex; align-items: center; width: 100%; }
    .j16-input-icon { position: absolute; left: 12px; font-size: 1rem; color: #64748b; }
    .j16-input-icon-wrapper input {
      width: 100%; padding: 11px 12px 11px 38px; border: 1.5px solid #1e293b;
      border-radius: 8px; background: #020617; color: #fff; font-size: 0.88rem;
      transition: all 0.2s; box-sizing: border-box;
    }
    .j16-input-icon-wrapper input:focus {
      outline: none; border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
    }
    .j16-eye-btn {
      position: absolute; right: 12px; background: none; border: none;
      font-size: 1rem; cursor: pointer; color: #64748b; padding: 2px;
    }
    .j16-login-options { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; font-size: 0.8rem; }
    .j16-remember-me { display: flex; align-items: center; gap: 8px; color: #94a3b8; cursor: pointer; }
    .j16-remember-me input { accent-color: #f59e0b; width: 15px; height: 15px; }
    .j16-login-options a { color: #f59e0b; text-decoration: none; font-weight: 700; }
    .j16-login-options a:hover { text-decoration: underline; }
    
    .j16-login-btn {
      width: 100%; padding: 12px; background: #f59e0b; border: none; border-radius: 8px;
      color: #020617; font-weight: 700; font-size: 0.92rem; cursor: pointer;
      transition: all 0.2s; box-shadow: 0 4px 12px rgba(245, 158, 11, 0.2);
    }
    .j16-login-btn:hover { background: #d97706; transform: translateY(-1px); }
    .j16-login-btn:active { transform: translateY(0); }
    
    .j16-login-divider {
      text-align: center; border-bottom: 1px solid #1e293b; line-height: 0.1em; margin: 24px 0;
    }
    .j16-login-divider span { background: #090d16; padding: 0 12px; color: #475569; font-size: 0.78rem; font-weight: 600; }
    
    .j16-google-btn {
      width: 100%; padding: 11px; background: #1e293b; border: 1.5px solid #334155; border-radius: 8px;
      color: #fff; font-weight: 700; font-size: 0.85rem; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      transition: all 0.2s; box-sizing: border-box;
    }
    .j16-google-btn:hover { background: #334155; border-color: #475569; }

    /* Ocultar elementos originais de login */
    body.j16-on-login #root {
      opacity: 0 !important;
      pointer-events: none !important;
      position: absolute !important;
      left: -9999px !important;
      width: 1px !important;
      height: 1px !important;
      overflow: hidden !important;
    }

    /* ---- Card Overlay ---- */
    .j16-overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; padding: 10px 14px;
      box-sizing: border-box;
      background: #ffffff;
      border-bottom: 1.5px solid #f1f5f9;
      z-index: 5; pointer-events: auto; cursor: pointer;
      transition: all 0.2s ease;
    }
    .j16-overlay:hover {
      background: #f8fafc;
    }
    .j16-avatar-wrap {
      position: relative; width: 50px; height: 50px;
      border-radius: 50%; overflow: hidden; flex-shrink: 0;
      margin-right: 14px;
      border: 2px solid #e2e8f0;
      background: #f8fafc;
      display: flex; align-items: center; justify-content: center;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.06);
    }
    .j16-avatar-wrap img { width: 100%; height: 100%; object-fit: cover; }
    .j16-status-dot {
      position: absolute; bottom: 1px; right: 1px;
      width: 13px; height: 13px; border-radius: 50%;
      border: 2px solid #fff;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
    }
    .j16-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .j16-name-row {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
    }
    .j16-name {
      font-size: 0.85rem; font-weight: 700; color: #1e293b;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      line-height: 1.2;
    }
    .j16-model-badge {
      font-size: 0.72rem; font-weight: 500; color: #64748b;
    }
    .j16-status-row {
      display: flex; align-items: center; gap: 6px;
      font-size: 0.75rem;
    }
    .j16-status-badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-weight: 600; padding: 1.5px 7px; border-radius: 4px;
      font-size: 0.7rem;
    }
    .j16-status-mov { background: #dcfce7; color: #166534; }
    .j16-status-stop { background: #fee2e2; color: #991b1b; }
    .j16-ts { font-size: 0.7rem; color: #94a3b8; font-weight: 500; }
    .j16-addr {
      font-size: 0.72rem; color: #64748b; font-weight: 400;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 200px;
    }
    .j16-no-addr { font-size: 0.72rem; color: #94a3b8; font-style: italic; }
    .j16-actions {
      display: flex; align-items: center; gap: 4px; flex-shrink: 0; margin-left: 6px;
    }
    .j16-card-btn {
      background: none; border: none; font-size: 1rem; cursor: pointer;
      color: #94a3b8; padding: 6px; display: flex; align-items: center;
      justify-content: center; border-radius: 6px; transition: all 0.2s;
    }
    .j16-card-btn:hover { color: #f59e0b; background: #f1f5f9; }
    .j16-star { position: absolute; top: 3px; left: 3px; font-size: 11px; z-index: 6; }

    /* Notificações coloridas */
    .notistack-MuiContent-success { background: #15803d !important; font-weight: 700 !important; border-radius: 8px !important; }
    .notistack-MuiContent-error   { background: #dc2626 !important; font-weight: 700 !important; border-radius: 8px !important; }
    .notistack-MuiContent-warning { background: #d97706 !important; font-weight: 700 !important; border-radius: 8px !important; }

    /* ---- Painel GPRS ---- */
    #gprs-panel {
      position: fixed; top: 0; right: -420px; width: 390px; height: 100vh;
      background: #fff; box-shadow: -6px 0 28px rgba(0,0,0,0.15);
      z-index: 999999; transition: right .3s cubic-bezier(.4,0,.2,1);
      display: flex; flex-direction: column;
      font-family: 'Inter', 'Roboto', sans-serif;
      border-left: 1px solid #e2e8f0;
    }
    #gprs-panel.open { right: 0; }
    #gprs-panel-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 16px; border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(135deg, #1e293b, #334155);
    }
    #gprs-title { margin: 0; font-size: 0.95rem; font-weight: 700; color: #fff; }
    #gprs-close {
      background: rgba(255,255,255,0.15); border: none; color: #fff;
      width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
      font-size: 1.1rem; display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    .gprs-btn {
      padding: 9px; border: none; border-radius: 6px;
      font-weight: 700; font-size: 0.8rem; cursor: pointer; width: 100%;
      transition: opacity 0.15s, transform 0.1s;
    }
    .gprs-btn:hover { opacity: 0.88; transform: translateY(-1px); }
    .gprs-btn:active { transform: translateY(0); }
    .gprs-btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    
    /* ---- Botão Gatilho de Logs no Canto Inferior Esquerdo ---- */
    #j16-system-log-trigger {
      position: fixed; left: 16px; bottom: 16px; z-index: 99999;
      background: #1e293b; color: #f43f5e; border: 1.5px solid #334155;
      padding: 8px 14px; border-radius: 20px; font-family: 'Inter', sans-serif;
      font-size: 0.78rem; font-weight: 700; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: all 0.2s ease-in-out;
    }
    #j16-system-log-trigger:hover {
      background: #f43f5e; color: #fff; border-color: #f43f5e;
      transform: translateY(-1px);
    }
    #j16-system-log-trigger:active {
      transform: translateY(0);
    }
    
    /* Esconder o gatilho se estiver na tela de login */
    body.j16-on-login #j16-system-log-trigger {
      display: none !important;
    }
    
    .gprs-section-title {
      font-size: 0.7rem; font-weight: 800; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.7px;
      border-bottom: 1px solid #f1f5f9; padding-bottom: 5px; margin: 14px 0 8px;
    }
    #gprs-log-area {
      height: 170px; background: #0f172a; padding: 10px 14px;
      display: flex; flex-direction: column; box-sizing: border-box;
      flex-shrink: 0;
    }
    #gprs-logs {
      flex: 1; overflow-y: auto; font-family: monospace;
      font-size: 0.72rem; color: #38bdf8; line-height: 1.6;
    }
    #gprs-logs::-webkit-scrollbar { width: 4px; }
    #gprs-logs::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

    /* ---- Formulário de Cadastro ---- */
    .j16-tab-bar { display: flex; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
    .j16-tab-btn {
      padding: 9px 14px; background: none; border: none;
      border-bottom: 2.5px solid transparent; color: #64748b;
      font-weight: 600; cursor: pointer; font-size: 0.82rem;
      transition: color 0.15s, border-color 0.15s; white-space: nowrap;
    }
    .j16-tab-btn:hover { color: #2563eb; }
    .j16-tab-btn.active { color: #2563eb; border-bottom-color: #2563eb; background: #fff; }
    .j16-field { margin-bottom: 10px; }
    .j16-field label {
      font-size: 0.76rem; color: #475569; font-weight: 700;
      display: block; margin-bottom: 3px;
    }
    .j16-field input, .j16-field select {
      width: 100%; padding: 8px; border: 1px solid #cbd5e1;
      border-radius: 5px; box-sizing: border-box; background: #fff;
      font-size: 0.84rem; color: #0f172a; transition: border-color 0.15s;
    }
    .j16-field input:focus, .j16-field select:focus {
      outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.12);
    }
    .j16-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  `;
  document.head.appendChild(style);

  // ─── HELPERS ──────────────────────────────────────────────────────────────
  function motoSvg(num, cor) {
    const fill = cor === 'vermelha' ? '#dc2626' : '#1e293b';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <circle cx="14" cy="45" r="8" fill="#334155" stroke="#0f172a" stroke-width="2"/>
        <circle cx="14" cy="45" r="3" fill="#cbd5e1"/>
        <circle cx="50" cy="45" r="8" fill="#334155" stroke="#0f172a" stroke-width="2"/>
        <circle cx="50" cy="45" r="3" fill="#cbd5e1"/>
        <path d="M50 45 L43 22 L38 21" fill="none" stroke="#475569" stroke-width="3.5" stroke-linecap="round"/>
        <path d="M14 45 L24 29 L45 29 L50 45 Z" fill="${fill}" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M18 29 Q24 26 30 29" fill="none" stroke="#0f172a" stroke-width="3" stroke-linecap="round"/>
        <rect x="24" y="36" width="12" height="8" rx="2" fill="#94a3b8" stroke="#475569" stroke-width="1.5"/>
        <text x="30" y="43" font-family="Arial" font-size="9" font-weight="900" fill="#fff" text-anchor="middle">${num}</text>
      </svg>`
    );
  }

  function timeAgo(ts) {
    if (!ts) return '–';
    const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60)  return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}min`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}min`;
  }

  function fmtTs(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
  }

  function deviceIcon(attrs) {
    const v = attrs?.vehicleIconVariant || '';
    if (v.startsWith('moto-')) {
      const parts = v.split('-');
      return motoSvg(parts[1] || '01', parts[2] || 'preta');
    }
    const photo = attrs?.vehiclePhoto || '';
    if (photo.startsWith('data:image/') || photo.startsWith('http')) return photo;
    return motoSvg('01', 'preta');
  }

  function formatAddressString(addrStr) {
    if (!addrStr || typeof addrStr !== 'string') return '';
    const parts = addrStr.split(',').map(p => p.trim());
    if (parts.length === 0) return '';
    
    // Tenta achar a rua (geralmente primeiro elemento)
    const street = parts[0] || '';
    let neighborhood = '';
    
    // Tenta achar o bairro
    if (parts[1]) {
      if (parts[1].includes('-')) {
        const sub = parts[1].split('-').map(s => s.trim());
        neighborhood = sub[1] || sub[0] || '';
      } else {
        neighborhood = parts[1];
      }
    }
    if ((!neighborhood || /^\d+/.test(neighborhood) || neighborhood.length > 25) && parts[2]) {
      neighborhood = parts[2];
    }
    
    if (street && neighborhood && !/^\d+/.test(neighborhood) && neighborhood !== street) {
      return `${street}, ${neighborhood}`;
    }
    return street || addrStr;
  }

  // ─── CACHE DE ENDEREÇOS (Nominatim com limite de 1 req/s) ─────────────────
  const _addrCache = {};
  const _addrPending = {};
  let _addrLastCall = 0;

  function getAddress(pos) {
    if (!pos) return null;
    if (pos.address && pos.address.trim()) return pos.address.trim();
    if (!pos.latitude || !pos.longitude) return null;
    const key = `${pos.latitude.toFixed(5)},${pos.longitude.toFixed(5)}`;
    return _addrCache[key] || null;
  }

  async function resolveAddress(pos, onResolved) {
    if (!pos || !pos.latitude || !pos.longitude) return;
    if (pos.address && pos.address.trim()) { onResolved(pos.address.trim()); return; }
    const key = `${pos.latitude.toFixed(5)},${pos.longitude.toFixed(5)}`;
    if (_addrCache[key]) { onResolved(_addrCache[key]); return; }
    if (_addrPending[key]) return;
    _addrPending[key] = true;

    // Respeitar o rate limit do Nominatim (mínimo de 1.1s entre requisições)
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - _addrLastCall));
    _addrLastCall = now + wait;

    setTimeout(async () => {
      try {
        const r = await _fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.latitude}&lon=${pos.longitude}&format=json&addressdetails=1`, {
          headers: { 'Accept-Language': 'pt-BR,pt;q=0.9' }
        });
        if (r.ok) {
          const j = await r.json();
          const a = j.address || {};
          const parts = [
            a.road || a.pedestrian || a.footway || a.path || '',
            a.house_number || '',
            a.suburb || a.neighbourhood || a.quarter || '',
            a.city || a.town || a.village || a.municipality || ''
          ].filter(Boolean);
          const addr = parts.join(', ');
          if (addr) {
            _addrCache[key] = addr;
            pos.address = addr; // Atualiza o objeto de posição na memória
            onResolved(addr);
          }
        }
      } catch (e) { /* silencioso */ }
      finally {
        delete _addrPending[key];
      }
    }, wait);
  }

  // ─── CUSTOMIZAR CARDS ─────────────────────────────────────────────────────
  let _rendering = false;

  function customCards() {
    if (_rendering) return;
    _rendering = true;
    try {
      const items = document.querySelectorAll(
        '.MuiListItemButton-root:not([data-j16-skip]), [class*="MuiListItemButton-root"]:not([data-j16-skip])'
      );
      
      items.forEach((item, idx) => {
        const device = getDeviceFromElement(item);
        if (!device) return;

        const pos    = window.traccarCache.positions[device.id];
        const attrs  = device.attributes || {};
        const model  = attrs.vehicleModel || device.model || '';
        const rawAddr = getAddress(pos) || '';
        const addr   = formatAddressString(rawAddr);
        const isMoving = pos ? (pos.attributes?.motion === true || pos.speed > 0.3) : false;
        const spd    = pos ? Math.round((pos.speed || 0) * 1.852) : 0;
        const stCol  = isMoving ? '#15803d' : '#b91c1c';
        const stLbl  = isMoving ? `▶ ${spd} km/h` : `■ ${timeAgo(pos?.fixTime || device.lastUpdate)}`;
        const stCls  = isMoving ? 'j16-status-mov' : 'j16-status-stop';
        const stIcon = isMoving ? '🟢' : '🔴';
        const isPri  = attrs.isPrimaryVehicle === true || attrs.isPrimaryVehicle === 'true';
        const icon   = deviceIcon(attrs);
        const ts     = pos ? fmtTs(pos.fixTime) : fmtTs(device.lastUpdate);

        const overlays = item.querySelectorAll('.j16-overlay');
        if (overlays.length > 1) {
          for (let i = 1; i < overlays.length; i++) {
            overlays[i].remove();
          }
        }
        const existing = overlays[0];

        if (existing) {
          // Só atualizar partes dinâmicas — evita re-criar o DOM
          const dot = existing.querySelector('.j16-status-dot');
          if (dot) dot.style.background = stCol;
          const badge = existing.querySelector('.j16-status-badge');
          if (badge) { badge.textContent = stLbl; badge.className = `j16-status-badge ${stCls}`; }
          const tsEl = existing.querySelector('.j16-ts');
          if (tsEl) tsEl.textContent = ts;
          const addrEl = existing.querySelector('.j16-addr, .j16-no-addr');
          if (addrEl) {
            addrEl.textContent = addr ? `📍 ${addr}` : 'Aguardando posição...';
            addrEl.className = addr ? 'j16-addr' : 'j16-no-addr';
          }
          const img = existing.querySelector('.j16-avatar-wrap img');
          if (img && img.src !== icon) img.src = icon;

          // Se não houver endereço resolvido e houver posição válida, disparar Nominatim em background
          if (!addr && pos) {
            resolveAddress(pos, (resolved) => {
              const elAddr = existing.querySelector('.j16-addr, .j16-no-addr');
              if (elAddr) {
                const formatted = formatAddressString(resolved);
                elAddr.textContent = `📍 ${formatted}`;
                elAddr.className = 'j16-addr';
              }
            });
          }
          return;
        }

        // Garantir position relative
        item.style.position = 'relative';

        const el = document.createElement('div');
        el.className = 'j16-overlay';
        el.innerHTML = `
          ${isPri ? '<span class="j16-star">⭐</span>' : ''}
          <div class="j16-avatar-wrap">
            <img src="${icon}" alt="Veículo">
            <span class="j16-status-dot" style="background:${stCol}"></span>
          </div>
          <div class="j16-info">
            <div class="j16-name-row">
              <span class="j16-name">${device.name}</span>
              ${model ? `<span class="j16-model-badge">/ ${model}</span>` : ''}
            </div>
            <div class="j16-status-row">
              <span class="j16-status-badge ${stCls}">${stLbl}</span>
              ${ts ? `<span class="j16-ts">${ts}</span>` : ''}
            </div>
            <div class="${addr ? 'j16-addr' : 'j16-no-addr'}">${addr ? '📍 ' + addr : 'Aguardando posição...'}</div>
          </div>
          <div class="j16-actions">
            <button class="j16-card-btn j16-btn-edit" title="Editar Veículo">📝</button>
            <button class="j16-card-btn j16-btn-gprs" title="Painel GPRS do dispositivo">⚙️</button>
          </div>
        `;

        // Se não houver endereço resolvido e houver posição válida, disparar Nominatim em background após criar
        if (!addr && pos) {
          resolveAddress(pos, (resolved) => {
            const elAddr = el.querySelector('.j16-addr, .j16-no-addr');
            if (elAddr) {
              const formatted = formatAddressString(resolved);
              elAddr.textContent = `📍 ${formatted}`;
              elAddr.className = 'j16-addr';
            }
          });
        }

        el.querySelector('.j16-btn-gprs').addEventListener('click', e => {
          e.stopPropagation();
          e.preventDefault();
          openPanel(device.id);
        });

        el.querySelector('.j16-btn-edit').addEventListener('click', e => {
          e.stopPropagation();
          e.preventDefault();
          // Simula o clique no botão de configurações nativo do Traccar para abrir o Dialog real
          const nativeConfigBtn = item.querySelector('button[aria-label="Edit"], button[title="Edit"], button[class*="MuiIconButton-root"]');
          if (nativeConfigBtn) {
            nativeConfigBtn.click();
          } else {
            // Fallback via React Fiber dispatch se não encontrar o botão no DOM
            const fiberKey = Object.keys(item).find(k => k.startsWith('__reactFiber$'));
            if (fiberKey) {
              let f = item[fiberKey];
              for (let i = 0; i < 20 && f; i++) {
                const props = f.memoizedProps || f.pendingProps;
                if (typeof props?.onClick === 'function') {
                  props.onClick(e);
                  break;
                }
                f = f.return;
              }
            }
          }
        });

        // Click na overlay propaga para o React (selecionar veículo no mapa)
        el.addEventListener('click', e => {
          if (e.target.closest('.j16-card-btn')) return;
          el.style.pointerEvents = 'none';
          const under = document.elementFromPoint(e.clientX, e.clientY);
          el.style.pointerEvents = 'auto';
          if (under && under !== el) under.click();
        });

        item.appendChild(el);
      });
    } catch (e) {
      console.warn('[J16] customCards error:', e);
    }
    _rendering = false;
  }

  function getDeviceFromElement(el) {
    // ─── REGRA DE ESCOPO ──────────────────────────────────────────────────────
    if (el.closest('.MuiDialog-root')) return null;

    // ─── DETECÇÃO VIA REACT FIBER ─────────────────────────────────────────────
    const fiberKey = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) {
      return null;
    }

    let fiber = el[fiberKey];
    let path = [];
    for (let i = 0; i < 30 && fiber; i++) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props) {
        // Obter chaves de props para diagnóstico
        const keys = Object.keys(props).filter(k => typeof props[k] !== 'function');
        path.push(`${fiber.type?.name || 'Fiber'} {${keys.slice(0,5).join(', ')}}`);

        let devId = null;
        if (props.device && typeof props.device === 'object') devId = props.device.id;
        else if (props.item && typeof props.item === 'object') devId = props.item.id;
        else if (props.deviceId) devId = props.deviceId;
        else if (props.id && window.traccarCache.devices[props.id]) devId = props.id;

        if (devId && window.traccarCache.devices[devId]) {
          return window.traccarCache.devices[devId];
        }

        // Virtualized list (react-window)
        if (props.data && typeof props.index === 'number' && Array.isArray(props.data)) {
          const d = props.data[props.index];
          let vId = null;
          if (d && typeof d === 'object') vId = d.id || d.deviceId;
          else if (typeof d === 'number' || typeof d === 'string') vId = d;

          if (vId && window.traccarCache.devices[vId]) {
            return window.traccarCache.devices[vId];
          }
        }
      }
      fiber = fiber.return;
    }
    
    // Fallback de texto seguro para garantir o funcionamento caso a detecção por Fiber falhe em alguma versão
    const txt = (el.textContent || '').trim();
    if (txt) {
      // Ignorar inputs ou botões de formulário
      if (!el.querySelector('input') && !el.querySelector('textarea') && el.tagName !== 'INPUT' && el.tagName !== 'BUTTON') {
        const found = Object.values(window.traccarCache.devices).find(d => d.name && txt.includes(d.name));
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  // ─── DEBOUNCE PARA MUTATION OBSERVER ─────────────────────────────────────
  let _debounceTimer = null;

  function scheduleRefresh(delay = 300) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(customCards, delay);
  }

  // Observar DOM (nível 1 apenas, sem subtree nos overlays)
  const obs = new MutationObserver(mutations => {
    const isOwnChange = mutations.every(m =>
      [...m.addedNodes].every(n =>
        n.nodeType !== 1 ||
        n.classList?.contains('j16-overlay') ||
        n.classList?.contains('j16-star') ||
        (n.id && n.id.startsWith('gprs'))
      )
    );
    if (isOwnChange) return;
    scheduleRefresh(250);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // ─── INJETAR CAMPOS NO FORMULÁRIO DE CADASTRO ─────────────────────────────
  function injectForm(dialog) {
    if (dialog.querySelector('#j16-form-ext')) return;
    // Aguardar o formulário carregar
    const nameInput = dialog.querySelector('input[name="name"], input#name');
    if (!nameInput) return;

    let da = {};
    const fiberKey = Object.keys(dialog).find(k => k.startsWith('__reactFiber$'));
    if (fiberKey) {
      let f = dialog[fiberKey];
      for (let i = 0; i < 35 && f; i++) {
        const p = f.memoizedProps || f.pendingProps;
        if (p?.device?.attributes) { da = p.device.attributes; break; }
        f = f.return;
      }
    }

    let iconOpts = '<option value="">Padrão do sistema</option>';
    for (let i = 1; i <= 20; i++) {
      const n = String(i).padStart(2, '0');
      ['preta', 'vermelha'].forEach(c => {
        const v = `moto-${n}-${c}`;
        const label = `Moto ${n} — ${c.charAt(0).toUpperCase() + c.slice(1)}`;
        iconOpts += `<option value="${v}" ${da.vehicleIconVariant === v ? 'selected' : ''}>${label}</option>`;
      });
    }

    const box = document.createElement('div');
    box.id = 'j16-form-ext';
    box.style.cssText = 'margin-top:18px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;';

    box.innerHTML = `
      <div class="j16-tab-bar">
        <button type="button" class="j16-tab-btn active" data-tab="t1">🚗 Dados do Veículo</button>
        <button type="button" class="j16-tab-btn" data-tab="t2">📟 Rastreador</button>
        <button type="button" class="j16-tab-btn" data-tab="t3">🏍️ Ícone</button>
      </div>
      <div style="padding:14px;background:#fff">

        <!-- ABA 1: Dados do Veículo -->
        <div id="j16-t1">
          <div class="j16-2col">
            <div class="j16-field">
              <label>Modelo</label>
              <input id="j16-in-model" value="${da.vehicleModel||''}" placeholder="Ex: Titan 160">
            </div>
            <div class="j16-field">
              <label>Marca</label>
              <select id="j16-in-brand">
                ${['Honda','Yamaha','Suzuki','Kawasaki','Outras'].map(b=>`<option value="${b}" ${da.vehicleBrand===b?'selected':''}>${b}</option>`).join('')}
              </select>
            </div>
            <div class="j16-field">
              <label>Ano</label>
              <input id="j16-in-year" type="number" value="${da.vehicleYear||new Date().getFullYear()}" min="2000" max="2030">
            </div>
            <div class="j16-field">
              <label>Cor</label>
              <input id="j16-in-color" value="${da.vehicleColor||''}" placeholder="Ex: Vermelha">
            </div>
            <div class="j16-field" style="grid-column:span 2">
              <label>Apelido / Descrição</label>
              <input id="j16-in-desc" value="${da.vehicleDescription||''}" placeholder="Ex: Moto 12 - Entrega Centro">
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:.83rem;font-weight:700;color:#0f172a;cursor:pointer;margin-top:4px">
            <input type="checkbox" id="j16-in-primary" ${da.isPrimaryVehicle===true||da.isPrimaryVehicle==='true'?'checked':''} style="width:16px;height:16px;accent-color:#2563eb">
            ⭐ Marcar como veículo principal
          </label>
        </div>

        <!-- ABA 2: Rastreador -->
        <div id="j16-t2" style="display:none">
          <div class="j16-2col">
            <div class="j16-field">
              <label>📟 IMEI</label>
              <input id="j16-in-imei" value="${da.deviceImei||''}" placeholder="Ex: 864943...">
            </div>
            <div class="j16-field">
              <label>📶 Número do SIM</label>
              <input id="j16-in-sim" value="${da.simNumber||''}" placeholder="Ex: (81) 99999-0000">
            </div>
            <div class="j16-field" style="grid-column:span 2">
              <label>🔧 Status do Equipamento</label>
              <select id="j16-in-equip-status">
                <option value="installed" ${da.equipmentStatus==='installed'?'selected':''}>✅ Instalado</option>
                <option value="stock" ${da.equipmentStatus==='stock'?'selected':''}>📦 Em estoque</option>
                <option value="maintenance" ${da.equipmentStatus==='maintenance'?'selected':''}>🔧 Em manutenção</option>
                <option value="removed" ${da.equipmentStatus==='removed'?'selected':''}>❌ Removido</option>
              </select>
            </div>
            <div class="j16-field" style="grid-column:span 2">
              <label>📂 Grupo de Frota</label>
              <select id="j16-in-group">
                ${['Motos - Entrega','Motos - Supervisão','Motos - Reserva','Carros','Outros'].map(g=>`<option value="${g}" ${da.vehicleGroupLabel===g?'selected':''}>${g}</option>`).join('')}
              </select>
            </div>
          </div>
          <!-- Foto do veículo -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin-top:4px">
            <p style="margin:0 0 10px;font-size:.78rem;font-weight:700;color:#475569">📷 Foto do Veículo (PNG)</p>
            <div style="display:flex;align-items:center;gap:12px">
              <div style="width:60px;height:60px;border-radius:8px;border:1.5px solid #cbd5e1;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#fff;flex-shrink:0">
                <img id="j16-preview-photo-img"
                  src="${da.vehiclePhoto||''}"
                  style="width:100%;height:100%;object-fit:cover;display:${da.vehiclePhoto?'block':'none'}">
                <span id="j16-no-photo" style="font-size:.6rem;color:#94a3b8;text-align:center;display:${da.vehiclePhoto?'none':'block'}">Sem foto</span>
              </div>
              <div>
                <input type="file" id="j16-upload-photo" accept="image/png" style="display:none">
                <button type="button" id="j16-upload-btn" style="padding:6px 14px;background:#fff;border:1.5px solid #cbd5e1;border-radius:5px;cursor:pointer;font-size:.8rem;font-weight:700;color:#334155">
                  Escolher imagem...
                </button>
                <p style="margin:4px 0 0;font-size:.68rem;color:#94a3b8">Somente PNG. Máx 2MB.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- ABA 3: Ícone -->
        <div id="j16-t3" style="display:none">
          <div class="j16-field" style="margin-bottom:12px">
            <label>Ícone Personalizado da Moto</label>
            <select id="j16-in-icon-variant">${iconOpts}</select>
          </div>
          <div style="display:flex;justify-content:center;align-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;min-height:100px">
            <img id="j16-icon-prev" src="" style="width:80px;height:80px;object-fit:contain;display:none">
            <span id="j16-icon-placeholder" style="font-size:.8rem;color:#94a3b8">Selecione um ícone para visualizar</span>
          </div>
          <p style="font-size:.72rem;color:#94a3b8;margin:8px 0 0;text-align:center">
            O ícone aparecerá no card e no mapa do veículo
          </p>
        </div>
      </div>
    `;

    // ── Lógica das Abas ──
    const tabs = box.querySelectorAll('.j16-tab-btn');
    const panes = { t1: box.querySelector('#j16-t1'), t2: box.querySelector('#j16-t2'), t3: box.querySelector('#j16-t3') };
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.forEach(b => b.classList.remove('active'));
        Object.values(panes).forEach(p => p && (p.style.display = 'none'));
        btn.classList.add('active');
        const pane = panes[btn.dataset.tab];
        if (pane) pane.style.display = 'block';
      });
    });

    // ── Preview do ícone ──
    const iconSel = box.querySelector('#j16-in-icon-variant');
    const iconPrev = box.querySelector('#j16-icon-prev');
    const iconPlaceholder = box.querySelector('#j16-icon-placeholder');
    const updateIconPrev = () => {
      const v = iconSel.value;
      if (v.startsWith('moto-')) {
        const [, n, c] = v.split('-');
        iconPrev.src = motoSvg(n, c);
        iconPrev.style.display = 'block';
        iconPlaceholder.style.display = 'none';
      } else {
        iconPrev.style.display = 'none';
        iconPlaceholder.style.display = 'block';
      }
    };
    iconSel.addEventListener('change', updateIconPrev);
    if (da.vehicleIconVariant) updateIconPrev();

    // ── Upload de Foto ──
    const uploadBtn = box.querySelector('#j16-upload-btn');
    const uploader = box.querySelector('#j16-upload-photo');
    uploadBtn.addEventListener('click', () => uploader.click());
    uploader.addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.type !== 'image/png') { alert('Apenas arquivos PNG são aceitos.'); return; }
      if (f.size > 2 * 1024 * 1024) { alert('Arquivo muito grande. Máximo: 2MB.'); return; }
      const r = new FileReader();
      r.onload = ev => {
        const img = box.querySelector('#j16-preview-photo-img');
        const ph = box.querySelector('#j16-no-photo');
        img.src = ev.target.result;
        img.style.display = 'block';
        ph.style.display = 'none';
      };
      r.readAsDataURL(f);
    });

    // ── Auto-preencher IMEI ──
    setTimeout(() => {
      const uid = dialog.querySelector('input[name="uniqueId"], input#uniqueId');
      const imei = box.querySelector('#j16-in-imei');
      if (uid && imei && !imei.value) imei.value = uid.value;
    }, 200);

    const target = dialog.querySelector('form') || dialog.querySelector('.MuiDialogContent-root') || dialog;
    target.appendChild(box);
  }

  // ─── PAINEL GPRS ──────────────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById('gprs-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'gprs-panel';
    panel.innerHTML = `
      <div id="gprs-panel-header">
        <h3 id="gprs-title">⚙️ Painel GPRS</h3>
        <button id="gprs-close" title="Fechar">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:14px;box-sizing:border-box">

        <div class="j16-field" style="margin-bottom:12px">
          <label>Dispositivo selecionado</label>
          <select id="gprs-dev" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-weight:600;color:#0f172a;background:#fff"></select>
        </div>

        <p class="gprs-section-title">Controle Remoto</p>
        <div class="gprs-btn-grid" style="margin-bottom:12px">
          <button class="gprs-btn" data-cmd="RELAY,1#" style="background:#dc2626;color:#fff">🔒 Bloquear Motor</button>
          <button class="gprs-btn" data-cmd="RELAY,0#" style="background:#16a34a;color:#fff">🔓 Desbloquear</button>
          <button class="gprs-btn" data-cmd="STATUS#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">📊 Status</button>
          <button class="gprs-btn" data-cmd="PARAM#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">🔧 Parâmetros</button>
        </div>

        <p class="gprs-section-title">Servidor</p>
        <button class="gprs-btn" data-cmd="SERVER,1,gps.3arastrearof.com.br,5023,0#"
          style="background:#2563eb;color:#fff;margin-bottom:12px">
          🌐 Apontar para este Servidor
        </button>

        <p class="gprs-section-title">Intervalo de Transmissão</p>
        <div class="gprs-btn-grid" style="margin-bottom:12px">
          <button class="gprs-btn" data-cmd="TIMER,10#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">⚡ 10 segundos</button>
          <button class="gprs-btn" data-cmd="TIMER,30#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">🕐 30 segundos</button>
          <button class="gprs-btn" data-cmd="TIMER,60#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">⏱️ 1 minuto</button>
          <button class="gprs-btn" data-cmd="TIMER,300#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">🕔 5 minutos</button>
        </div>

        <p class="gprs-section-title">Fuso Horário</p>
        <div class="gprs-btn-grid" style="margin-bottom:12px">
          <button class="gprs-btn" data-cmd="GMT,W,3,0#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">🇧🇷 GMT-3 (Brasil)</button>
          <button class="gprs-btn" data-cmd="GMT,E,0,0#" style="background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0">🌍 GMT 0</button>
        </div>

        <p class="gprs-section-title">Manutenção</p>
        <button class="gprs-btn" data-cmd="RESET#"
          style="background:#f97316;color:#fff;margin-bottom:12px">
          🔄 Reiniciar Rastreador
        </button>

        <p class="gprs-section-title">Comando Personalizado</p>
        <div style="display:flex;gap:8px;margin-bottom:4px">
          <input id="gprs-cmd-input" type="text" placeholder="Ex: STATUS#"
            style="flex:1;padding:8px 10px;border:1.5px solid #cbd5e1;border-radius:6px;font-size:.85rem;font-family:monospace">
          <button id="gprs-cmd-send"
            style="background:#0ea5e9;color:#fff;padding:8px 16px;border:none;border-radius:6px;font-weight:700;cursor:pointer;white-space:nowrap">
            ➤ Enviar
          </button>
        </div>
        <p style="font-size:.68rem;color:#94a3b8;margin:0">Use a sintaxe do protocolo J16 (ex: RELAY,1#)</p>
      </div>
      <div id="gprs-log-area">
        <div class="j16-tab-bar" style="border-top: 1px solid #334155; background: #1e293b;">
          <button type="button" class="j16-tab-btn active" id="j16-tab-gprs-logs" style="color: #94a3b8; border-bottom: 2.5px solid transparent; padding: 6px 12px; font-size: 0.72rem;">📟 Respostas GPRS</button>
          <button type="button" class="j16-tab-btn" id="j16-tab-sys-logs" style="color: #94a3b8; border-bottom: 2.5px solid transparent; padding: 6px 12px; font-size: 0.72rem;">💻 Logs do Sistema</button>
        </div>
        <div id="gprs-logs" style="flex: 1; overflow-y: auto; padding: 8px 14px; font-family: monospace; font-size: 0.72rem; color: #38bdf8; line-height: 1.6;"></div>
        <div id="sys-logs" style="flex: 1; overflow-y: auto; padding: 8px 14px; font-family: monospace; font-size: 0.72rem; color: #f43f5e; line-height: 1.6; display: none;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Lógica de abas de Log
    const tabGprs = panel.querySelector('#j16-tab-gprs-logs');
    const tabSys = panel.querySelector('#j16-tab-sys-logs');
    const divGprs = panel.querySelector('#gprs-logs');
    const divSys = panel.querySelector('#sys-logs');

    tabGprs.addEventListener('click', () => {
      tabGprs.classList.add('active');
      tabGprs.style.color = '#38bdf8';
      tabSys.classList.remove('active');
      tabSys.style.color = '#94a3b8';
      divGprs.style.display = 'block';
      divSys.style.display = 'none';
    });

    tabSys.addEventListener('click', () => {
      tabSys.classList.add('active');
      tabSys.style.color = '#f43f5e';
      tabGprs.classList.remove('active');
      tabGprs.style.color = '#94a3b8';
      divSys.style.display = 'block';
      divGprs.style.display = 'none';
      renderSystemLogs();
    });

    panel.querySelector('#gprs-close').addEventListener('click', () => {
      panel.classList.remove('open');
      clearInterval(_pollTimer);
    });

    panel.querySelector('#gprs-cmd-send').addEventListener('click', () => {
      const inp = document.getElementById('gprs-cmd-input');
      const v = inp.value.trim();
      if (v) { sendCmd(v); inp.value = ''; }
    });

    document.getElementById('gprs-cmd-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v) { sendCmd(v); e.target.value = ''; }
      }
    });

    panel.querySelectorAll('.gprs-btn[data-cmd]').forEach(btn => {
      btn.addEventListener('click', () => sendCmd(btn.dataset.cmd));
    });
  }

  function gprsLog(msg, type = 'info') {
    const div = document.getElementById('gprs-logs');
    if (!div) return;
    const t = new Date().toLocaleTimeString('pt-BR');
    const colors = { info: '#38bdf8', success: '#4ade80', error: '#f87171', warn: '#fb923c' };
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:#475569;font-size:.65rem">[${t}]</span> <span style="color:${colors[type]}">${msg}</span>`;
    div.appendChild(line);
    div.scrollTop = div.scrollHeight;
  }

  function refreshPanelDevices() {
    const sel = document.getElementById('gprs-dev');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Selecione o dispositivo —</option>';
    Object.values(window.traccarCache.devices)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(d => {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = `${d.name} (${d.uniqueId})`;
        if (String(d.id) === String(cur)) o.selected = true;
        sel.appendChild(o);
      });
  }

  async function sendCmd(cmd) {
    const devId = document.getElementById('gprs-dev')?.value;
    if (!devId) { gprsLog('⚠️ Selecione um dispositivo primeiro!', 'warn'); return; }
    gprsLog(`📤 Enviando: <b style="color:#e2e8f0">${cmd}</b>`, 'info');
    try {
      const r = await _fetch('/api/commands/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: +devId, type: 'custom', attributes: { data: cmd } })
      });
      if (r.ok) {
        gprsLog('✅ Comando transmitido! Aguardando resposta do rastreador...', 'success');
      } else {
        const txt = await r.text();
        gprsLog(`❌ Erro ${r.status}: ${txt}`, 'error');
      }
    } catch (e) {
      gprsLog(`❌ Falha na conexão: ${e.message}`, 'error');
    }
  }

  let _pollTimer;
  function startPolling(devId) {
    clearInterval(_pollTimer);
    let since = new Date().toISOString();
    _pollTimer = setInterval(async () => {
      const panel = document.getElementById('gprs-panel');
      if (!panel?.classList.contains('open')) { clearInterval(_pollTimer); return; }
      try {
        const to = new Date(Date.now() + 60000).toISOString();
        const r = await _fetch(`/api/reports/events?from=${since}&to=${to}&type=commandResult&deviceId=${devId}`);
        if (r.ok) {
          const evts = await r.json();
          if (Array.isArray(evts)) {
            evts.filter(e => String(e.deviceId) === String(devId)).forEach(e => {
              gprsLog(`📩 Resposta: <b style="color:#e2e8f0">${e.attributes?.result || 'OK'}</b>`, 'success');
            });
            if (evts.length > 0) {
              since = new Date(new Date(evts[evts.length - 1].eventTime).getTime() + 1000).toISOString();
            }
          }
        }
      } catch (e) { /* silencioso */ }
    }, 3000);
  }

  async function openPanel(devId, switchTab = false) {
    buildPanel();
    refreshPanelDevices();
    const panel = document.getElementById('gprs-panel');
    const dev = window.traccarCache.devices[devId];
    if (dev) {
      const sel = document.getElementById('gprs-dev');
      if (sel) sel.value = devId;
      const title = document.getElementById('gprs-title');
      if (title) title.textContent = `⚙️ GPRS — ${dev.name}`;
    }
    panel.classList.add('open');
    
    if (switchTab) {
      // Forçar a visualização dos logs do sistema
      const tabSys = panel.querySelector('#j16-tab-sys-logs');
      if (tabSys) tabSys.click();
    } else {
      // Padrão GPRS
      const tabGprs = panel.querySelector('#j16-tab-gprs-logs');
      if (tabGprs) tabGprs.click();
    }
    
    gprsLog('🟢 Painel aberto. Monitorando respostas...', 'info');
    if (devId) startPolling(devId);
  }

  // Injetar botão flutuante permanente no rodapé da sidebar/painel esquerdo
  function injectSystemLogTrigger() {
    if (document.getElementById('j16-system-log-trigger')) return;
    
    const trigger = document.createElement('div');
    trigger.id = 'j16-system-log-trigger';
    trigger.innerHTML = `<span>💻 Console de Logs</span>`;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      // Abre o painel sem selecionar veículo específico, ativando aba de Logs do Sistema
      const activeDevId = document.getElementById('gprs-dev')?.value || '';
      openPanel(activeDevId, true);
    });
    
    document.body.appendChild(trigger);
  }

  // ─── CUSTOM LOGIN E IDENTIDADE VISUAL ─────────────────────────────────────
  function setReactInputValue(inputEl, value) {
    if (!inputEl) return;
    try {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeInputValueSetter.call(inputEl, value);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      inputEl.value = value;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function handleCustomLoginSubmit() {
    const customUser = document.getElementById('j16-login-user')?.value || '';
    const customPass = document.getElementById('j16-login-pass')?.value || '';
    
    // Encontrar os campos reais de login do Traccar (invisíveis)
    const origUser = document.querySelector('input[name="email"], input#email, input[type="email"], input[autocomplete="username"]') || document.querySelector('input[type="text"]');
    const origPass = document.querySelector('input[type="password"], input[name="password"], input#password, input[autocomplete="current-password"]');
    const origBtn = document.querySelector('button[type="submit"], button.MuiButton-root[type="submit"]');

    if (origUser && origPass) {
      // Sincronizar dados com o React usando o setter nativo
      setReactInputValue(origUser, customUser);
      setReactInputValue(origPass, customPass);
      
      // Simular clique no botão original de envio com timeout adequado para ciclo React
      setTimeout(() => {
        if (origBtn) {
          origBtn.click();
        } else {
          const form = origUser.closest('form');
          if (form) {
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          }
        }
      }, 100);
    } else {
      console.warn('[J16] Campos de login originais não encontrados no DOM.');
      // Se por algum motivo o Traccar mudar o layout, tenta submeter o formulário padrão se houver
      const form = document.querySelector('form');
      if (form) form.submit();
    }
  }

  function buildLoginScreen() {
    if (document.getElementById('j16-login-wrapper')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'j16-login-wrapper';
    wrapper.innerHTML = `
      <div class="j16-login-container">
        <!-- Lado Esquerdo: Banner Brand -->
        <div class="j16-login-banner">
          <div class="j16-login-banner-content">
            <div class="j16-login-logo">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 130" width="220" style="vertical-align:middle">
                <!-- Ícone da Rota e do GPS Pin -->
                <path d="M105 110 C95 80, 115 60, 110 45" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
                <path d="M105 110 C95 80, 115 60, 110 45" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="3 3"/>
                <circle cx="110" cy="40" r="7" fill="#f59e0b"/>
                <circle cx="110" cy="40" r="2.5" fill="#fff"/>
                <!-- Texto 3A em Amarelo -->
                <text x="20" y="92" font-family="'Inter', 'Outfit', sans-serif" font-size="78" font-weight="900" fill="#f59e0b" letter-spacing="-3">3A</text>
                <!-- Texto RASTREAR em Branco -->
                <text x="135" y="65" font-family="'Inter', 'Outfit', sans-serif" font-size="34" font-weight="900" fill="#fff" letter-spacing="1">RASTREAR</text>
                <text x="135" y="86" font-family="'Inter', 'Outfit', sans-serif" font-size="9" font-weight="800" fill="#94a3b8" letter-spacing="3.2">MONITORAMENTO INTELIGENTE</text>
              </svg>
            </div>
            
            <h2 class="j16-login-title">Bem-vindo de volta!</h2>
            <p class="j16-login-subtitle">Faça login para acessar sua conta e monitorar seus veículos em tempo real.</p>
            
            <!-- Benefícios -->
            <div class="j16-login-features">
              <div class="j16-feature-item">
                <span class="j16-feature-icon">⚡</span>
                <div>
                  <strong>Monitoramento em tempo real</strong>
                  <p>Acompanhe a frota segundo a segundo</p>
                </div>
              </div>
              <div class="j16-feature-item">
                <span class="j16-feature-icon">🔒</span>
                <div>
                  <strong>Segurança e confiabilidade</strong>
                  <p>Seus dados encriptados e seguros</p>
                </div>
              </div>
              <div class="j16-feature-item">
                <span class="j16-feature-icon">📞</span>
                <div>
                  <strong>Suporte 24 horas</strong>
                  <p style="color: #f59e0b; font-weight: 700; font-size: 0.85rem; margin-top: 2px">81 98593-8044</p>
                </div>
              </div>
            </div>

            <!-- Aviso de Limpeza de Cache -->
            <div class="j16-cache-alert">
              <span class="j16-alert-icon">⚠️</span>
              <p><strong>Dica:</strong> Sempre que o sistema for atualizado, pressione <kbd>Ctrl + F5</kbd> para limpar o cache do navegador e carregar a versão mais recente.</p>
            </div>
          </div>
          
          <div class="j16-login-footer">
            © 2026 3A RASTREAR • Todos os direitos reservados
          </div>
        </div>

        <!-- Lado Direito: Formulário -->
        <div class="j16-login-form-side">
          <div class="j16-login-form-box">
            <h3 class="j16-form-title">Entrar na sua conta</h3>
            <p class="j16-form-desc">Insira suas credenciais abaixo</p>

            <form id="j16-custom-login-form" onsubmit="return false;">
              <div class="j16-form-field">
                <label for="j16-login-user">Usuário ou E-mail</label>
                <div class="j16-input-icon-wrapper">
                  <span class="j16-input-icon">👤</span>
                  <input type="text" id="j16-login-user" placeholder="Digite seu usuário ou e-mail" required>
                </div>
              </div>
              
              <div class="j16-form-field">
                <label for="j16-login-pass">Senha</label>
                <div class="j16-input-icon-wrapper">
                  <span class="j16-input-icon">🔒</span>
                  <input type="password" id="j16-login-pass" placeholder="Digite sua senha" required>
                  <button type="button" id="j16-toggle-pass" class="j16-eye-btn" title="Mostrar/Ocultar senha">👁️</button>
                </div>
              </div>

              <div class="j16-login-options">
                <label class="j16-remember-me">
                  <input type="checkbox" id="j16-login-remember">
                  Lembrar-me
                </label>
                <a href="#" id="j16-forgot-pass-link">Esqueceu sua senha?</a>
              </div>

              <button type="submit" id="j16-btn-login" class="j16-login-btn" style="margin-bottom: 10px;">Entrar</button>
            </form>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(wrapper);

    // Toggle password
    const togglePass = wrapper.querySelector('#j16-toggle-pass');
    const passInput = wrapper.querySelector('#j16-login-pass');
    togglePass.addEventListener('click', () => {
      const isPass = passInput.type === 'password';
      passInput.type = isPass ? 'text' : 'password';
      togglePass.textContent = isPass ? '🙈' : '👁️';
    });

    // Form submit
    wrapper.querySelector('#j16-custom-login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      handleCustomLoginSubmit();
    });

    // Forgot password
    wrapper.querySelector('#j16-forgot-pass-link').addEventListener('click', (e) => {
      e.preventDefault();
      const origLink = document.querySelector('a[href*="password"], button[class*="forgot"], [class*="forgot"] a');
      if (origLink) {
        origLink.click();
      } else {
        alert('Para recuperar sua senha, utilize o botão nativo do sistema.');
      }
    });
  }

  function checkLoginScreen() {
    const hasPassField = document.querySelector('input[type="password"]');
    const isMainApp = !!document.querySelector('.MuiListItemButton-root');
    const wrapper = document.getElementById('j16-login-wrapper');

    if (hasPassField && !isMainApp) {
      document.body.classList.add('j16-on-login');
      buildLoginScreen();
    } else {
      document.body.classList.remove('j16-on-login');
      if (wrapper) wrapper.remove();
    }
  }

  function customizeHeaderLogo() {
    const toolbar = document.querySelector('.MuiToolbar-root');
    if (!toolbar) return;
    const title = toolbar.querySelector('h6, [class*="title"], [class*="Typography"]');
    if (title && (title.textContent === 'Traccar' || title.textContent.includes('3A RASTREAR') || title.textContent.trim() === '')) {
      if (!title.querySelector('.j16-header-logo')) {
        title.innerHTML = `
          <div class="j16-header-logo" style="display:flex;align-items:center;gap:6px">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 50" width="105" height="35" style="vertical-align:middle">
              <path d="M12 28 Q24 26 24 18 Q24 10 12 10 L3 10 L3 16 L12 16 Q18 16 18 19 Q18 22 12 22 L7 22 L7 28 L12 28 Q19 28 19 32 Q19 36 12 36 L3 36 L3 42 L12 42 Q24 42 24 35 Q24 28 12 28 Z" fill="#f59e0b"/>
              <path d="M44 10 L30 42 L38 42 L41 34 L51 34 L54 42 L62 42 L48 10 Z M46 18 L49 28 L42 28 Z" fill="#f59e0b"/>
              <circle cx="40" cy="18" r="3.5" fill="#fff"/>
              <text x="68" y="32" font-family="'Inter', sans-serif" font-size="14" font-weight="900" fill="#fff" letter-spacing="0.5">RASTREAR</text>
            </svg>
          </div>
        `;
      }
    }
  }

  // ─── OBSERVAR ABERTURA DE DIÁLOGOS E LOGIN ───────────────────────────────
  const obsDialog = new MutationObserver(() => {
    // Verificar diálogo
    document.querySelectorAll('.MuiDialog-root').forEach(dlg => {
      if (!dlg.querySelector('#j16-form-ext')) {
        setTimeout(() => { try { injectForm(dlg); } catch(e) {} }, 300);
      }
    });

    // Verificar tela de login
    checkLoginScreen();

    // Customizar logo na barra superior
    customizeHeaderLogo();

    // Injetar gatilho de logs na UI do Traccar se logado
    if (document.querySelector('.MuiListItemButton-root')) {
      injectSystemLogTrigger();
    }
  });
  obsDialog.observe(document.body, { childList: true, subtree: true });

  // ─── INICIALIZAÇÃO ────────────────────────────────────────────────────────
  function waitForLogin() {
    const check = setInterval(() => {
      checkLoginScreen();
      customizeHeaderLogo();
      if (document.querySelector('.MuiListItemButton-root')) {
        clearInterval(check);
        injectSystemLogTrigger();
        preloadCache();
      }
    }, 500);
  }

  if (document.querySelector('.MuiListItemButton-root')) {
    injectSystemLogTrigger();
    preloadCache();
  } else {
    waitForLogin();
  }

})();
