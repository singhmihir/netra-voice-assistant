/**
 * Netra Live - Gemini stage (light field). A near-black surface and two small light
 * fields, each one fragment shader at ~1/4 CSS resolution, scaled up by CSS: the orb
 * (flowing gradient light on the tap target; an opaque canvas carrying its own halo)
 * and Gemini Live's glow at the foot (repainted at 1/3 rate). On software GL the
 * compositor cost grows with canvas area, so the rest is a plain CSS background.
 * Canvas2D fallback without WebGL. Reads __netraState/__netraLevel/__netraBands.
 * API: window.NetraStage3D = { mount(host) -> bool, unmount(), fps() -> number }. ES5.
 */
window.NetraStage3D = (function () {
    'use strict';

    var root = null, O = null, G = null, host = null, sprites = null;
    var raf = 0, mq = null, reduced = false, onVis = null, onMq = null, onResize = null;
    var lastTs = 0, lastDraw = 0, fpsEma = 0, age = 0, winN = 0, slowN = 0, tier = 0, frameNo = 0;
    var cssW = 0, cssH = 0, measAt = -1e9, ox = 0, oy = 0, oR = 0;
    var lvF = 0, lvS = 0, bLo = 0, bHi = 0, errP = 0, lastSt = '';
    var tFlow = 3.7, shPh = 0, swPh = 0, brPh = 0;
    var KEYS = ['spd', 'warm', 'think', 'dim', 'gain', 'glowH', 'glowG', 'cool', 'talk', 'voice'];
    var P = {}, T = {};
    var OK = 1.8;   // orb canvas half-side, in orb radii (room for the halo)
    var GH = 0.4;   // glow canvas height, as a fraction of the stage height (capped at 820 px)
    var BG = '#0e0e10';
    // 2D sprites: blue deep/main/light, cyan, violet, rose, pale, (orb body), grey
    var COLS = [[26, 115, 232], [66, 133, 244], [138, 180, 248], [79, 195, 247], [155, 114, 203], [217, 101, 112], [200, 222, 255], null, [118, 128, 150]];

    var VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}';
    // premultiplied out: dormant greys, error tints rose, a hue-keeping soft clip
    var HEAD = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n' +
        'const vec3 B0=vec3(.102,.451,.910);const vec3 B1=vec3(.259,.522,.957);const vec3 B2=vec3(.541,.706,.973);' +
        'const vec3 B3=vec3(.659,.780,.980);const vec3 CY=vec3(.31,.765,.969);const vec3 VL=vec3(.608,.447,.796);' +
        'const vec3 RL=vec3(.851,.396,.439);const vec3 BG=vec3(.0549,.0549,.0627);\n' +
        'vec4 outp(vec3 c,float dim,float err){float l=dot(c,vec3(.3,.59,.11));c=mix(c,vec3(l)*vec3(.9,.95,1.08),dim*.65);' +
        'c=mix(c,vec3(l*1.3,l*.62,l*.7),err*.7);float m=max(c.r,max(c.g,c.b));' +
        'if(m>.8){float k=.8+.2*(1.0-exp((.8-m)/.2));c=mix(c*(k/m),vec3(k),clamp((m-1.0)*.3,0.0,.3));m=k;}' +
        'return vec4(c,clamp(m,0.0,1.0));}\n';

    // the orb, in orb radii. No atan (angular terms are Chebyshev multiples of the unit
    // direction); time-only trig terms arrive as uniforms
    var FS_ORB = HEAD + [
        'uniform vec2 uR;uniform vec4 uA,uL,uS,uG,uP,uQ;',
        'void main(){',
        'vec2 q=(gl_FragCoord.xy/uR*2.0-1.0)*' + OK.toFixed(2) + ';float d=length(q);',
        'if(d>' + (OK * 0.99).toFixed(3) + '){gl_FragColor=vec4(BG,1.0);return;}',
        'float t=uA.x;vec2 n=q/max(d,1e-4);float c=n.x,s=n.y;',
        'float c2=c*c-s*s,s2=2.0*c*s,c3=c*(4.0*c*c-3.0),s3=s*(3.0-4.0*s*s);',
        'float r=uA.z*(1.0+uL.x)*(1.0+.015*(s3*uP.x+c3*uP.y)+.01*(s2*uP.w-c2*uP.z)+uL.z*.04*(s2*uP.z+c2*uP.w)+uL.w*.012*(s3*uP.z-c3*uP.w));',
        'float dn=d/r,h=max(dn-1.0,0.0);',
        'vec3 L=mix(B0,B1,.45)*(exp(-h*5.0)*.22+exp(-h*1.7)*.1)*smoothstep(.55,1.0,dn);',
        'if(dn<1.08){',
        // flowing light: sine domain warp, plus a fine octave on her high band
        ' vec2 w=q/r*.95;',
        ' w+=.5*vec2(sin(w.y*1.6+t*.61),sin(w.x*1.4-t*.53));',
        ' w+=.28*vec2(sin(w.y*2.7-t*.83+1.3),sin(w.x*2.4+t*.71+2.1));',
        ' if(uL.w>.01)w+=.2*uL.w*vec2(sin(w.y*5.3+uA.y),sin(w.x*4.9-uA.y*1.1));',
        ' float f1=.5+.5*sin(w.x*1.5+w.y*.9+t*.2),f2=.5+.5*sin(w.y*1.8-w.x*.7+1.9),f3=.5+.5*sin((w.x-w.y)*2.1+.7);',
        ' float e=sqrt(max(1.0-dn*dn,0.0)),body=1.0-smoothstep(.78,1.03,dn);',
        // the Gemini gradient (blue > violet > rose) turns slowly across the orb; warm light
        // replaces the pale blue rather than mixing into it, so it never greys
        ' float gd=dot(q/r,uQ.zw)*.55+.5+(f1-.5)*.45;',
        ' float wv=uS.x*smoothstep(.42,.84,gd),wr=uS.x*smoothstep(.8,1.14,gd);',
        ' vec3 oc=mix(B0,B1,smoothstep(.1,.9,f1));',
        ' oc=mix(oc,B2,smoothstep(.35,1.0,f2)*(.2+.55*e)*(1.0-.8*wv));',
        ' oc=mix(oc,CY,smoothstep(.4,1.0,f3)*uG.y*.75);',
        ' oc=mix(oc,VL,wv*.85);oc=mix(oc,RL,wr*.62);',
        ' vec2 cc=q/r-vec2(uA.w,.16+.12*uQ.x);',   // a luminous core wandering with the flow
        ' oc=mix(oc,vec3(.74,.84,.99),exp(-dot(cc,cc)*2.8)*(.26+.16*uL.y)*(1.0-.6*wv));',
        ' L+=oc*(.42+.5*e+.14*f2)*body;',
        ' vec3 rc=mix(B2,CY,uG.y*.6);rc=mix(rc,mix(VL,RL,.5+.5*dot(n,uQ.xy)),uS.x*.7);',   // soft rim light
        ' L+=rc*exp(-(dn-.92)*(dn-.92)*80.0)*.2;',
        ' float f6=f3*f3*f3;f6*=f6;L+=vec3(.8,.9,1.0)*f6*f6*body*(.02+.4*uL.w);',   // fine shimmer
        '}',
        'if(uS.y>.01){',   // thinking: a Gemini gradient arc sweeping around the orb
        ' float a1=.5+.5*dot(n,uG.zw),a2=1.0-a1;a1*=a1*a1;a1*=a1;a2*=a2*a2;a2*=a2;',
        ' vec3 sc=mix(B1,VL,.5+.5*dot(n,uQ.yx));sc=mix(sc,RL,a2*.7);',
        ' L+=(sc*(a1+.55*a2)*exp(-(dn-.92)*(dn-.92)*30.0)*.8+B2*a1*smoothstep(.15,.6,dn)*(1.0-smoothstep(.7,1.0,dn))*.12)*uS.y;',
        '}',
        'L*=uG.x*(1.0-smoothstep(' + (OK * 0.76).toFixed(3) + ',' + (OK * 0.99).toFixed(3) + ',d));',
        'vec4 o=outp(L,uS.z,uS.w);gl_FragColor=vec4(BG*(1.0-o.a)+o.rgb,1.0);}'
    ].join('\n');

    // Gemini Live's glow (stage-height units from the bottom): a blue cloud bank with
    // drifting plumes, a paler foot, violet/rose clouds while she speaks
    var FS_GLOW = HEAD + [
        'uniform vec2 uR;uniform vec4 uA,uG,uW;',
        'void main(){',
        'vec2 u=gl_FragCoord.xy/uR;float x=u.x,y=u.y*uA.y,t=uA.x;',
        'float n1=sin(x*2.9+t*.23)+.55*sin(x*6.1-t*.31+1.7)+.7*sin(x*1.5+t*.13+4.1);',
        'float n2=sin(x*2.3-t*.19+2.3)+.6*sin(x*4.7+t*.27+.4);',
        'float p1=x-uW.z,p2=x-uW.w;p1=exp(-p1*p1*18.0);p2=exp(-p2*p2*24.0);',
        'float hA=uG.x*(.8+.16*n1+.45*p1+.35*p2),hB=uG.x*.5*(1.0+.34*n2+.4*p1);',
        'float ya=y/hA,gA=exp(-ya*ya*(.55+.45*ya)),gB=exp(-y/hB);',
        'float bx=.55+.45*(.5+.5*sin(x*2.1-t*.15+n2*.6));',
        'vec3 cA=mix(B0,B1,.5+.5*sin(x*3.1+t*.11+n1*.5));',
        'vec3 cB=mix(mix(B2,B3,.5+.3*n2),CY,uG.z*(.5+.5*sin(x*4.3+t*.2+2.0)));',
        'vec3 L=cA*gA*.85*(.35+.65*bx)+cB*gB*gB*.62*bx;',
        'float pv=x-uW.x,pr=x-uW.y;pv=exp(-pv*pv*22.0);pr=exp(-pr*pr*28.0);',
        'L=mix(L,L*.6+(VL*pv*.7+RL*pr*.55)*gA,uG.w*max(pv,pr));',
        'L*=uG.y*(1.0-smoothstep(uA.y*.5,uA.y*.98,y));',
        'gl_FragColor=outp(L,uA.z,uA.w);}'
    ].join('\n');

    function num(v) { v = +v; return isFinite(v) ? v : 0; }
    function approach(cur, tgt, dt, att, rel) { return cur + (tgt - cur) * (1 - Math.exp(-dt / (tgt > cur ? att : rel))); }

    function targets(st) {
        T.spd = 1; T.warm = 0.1; T.think = 0; T.dim = 0; T.gain = 0.9; T.glowH = 0.13; T.glowG = 0.62; T.cool = 0.3; T.talk = 1; T.voice = 0;
        if (st === 'thinking') { T.spd = 1.75; T.think = 1; T.warm = 0.18; T.glowH = 0.12; T.glowG = 0.55; T.cool = 0.15; T.talk = 0; }
        else if (st === 'speaking') { T.spd = 1.3; T.warm = 0.85; T.gain = 0.95; T.glowH = 0.14; T.glowG = 0.66; T.cool = 0.1; T.talk = 0; T.voice = 1; }
        else if (st === 'dormant') { T.spd = 0.3; T.dim = 1; T.gain = 0.4; T.glowH = 0.1; T.glowG = 0.2; T.cool = 0; T.warm = 0; T.talk = 0; }
        else if (st === 'boot') { T.gain = 0.6; T.glowG = 0.35; T.talk = 0; }
    }

    function css() {
        if (document.getElementById('ngs-css')) return;
        var s = document.createElement('style');
        s.id = 'ngs-css';
        s.textContent = '.ngs-stage{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;background:' + BG + ';pointer-events:none;z-index:0}' +
            '.ngs-stage *{pointer-events:none}.ngs-stage .ngs-cv{position:absolute;display:block}';
        (document.head || document.documentElement).appendChild(s);
    }

    // ---------- layers: a canvas with a WebGL program or a 2D context ----------
    function glProg(cv, fs, names, opaque) {
        var gl = null, o = { alpha: !opaque, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
        try { gl = cv.getContext('webgl', o) || cv.getContext('experimental-webgl', o); } catch (e) { gl = null; }
        if (!gl) return null;
        function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }
        var v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, fs), p = gl.createProgram(), U = {}, i;
        if (!v || !f) return null;
        gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
        gl.useProgram(p);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        i = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 2, gl.FLOAT, false, 0, 0);
        for (i = 0; i < names.length; i++) U[names[i]] = gl.getUniformLocation(p, names[i]);
        return { gl: gl, U: U };
    }
    // placement is inline so page rules such as '.netra-stage-3d canvas {width:100%}' can not stretch it
    function layer(place, fs, names, useGL, opaque) {
        var L = { cv: null, gl: null, U: null, c2: null, w: 0, h: 0, scale: 0.32, sig: -1 }, g;
        function fresh() {
            if (L.cv && L.cv.parentNode) L.cv.parentNode.removeChild(L.cv);
            L.cv = document.createElement('canvas'); L.cv.className = 'ngs-cv'; L.cv.style.cssText = place;
            root.appendChild(L.cv);
        }
        fresh();
        g = useGL ? glProg(L.cv, fs, names, opaque) : null;
        if (g) {
            L.gl = g.gl; L.U = g.U;
            L.cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); L.gl = null; });
            L.cv.addEventListener('webglcontextrestored', function () { var r = glProg(L.cv, fs, names, opaque); if (r) { L.gl = r.gl; L.U = r.U; L.w = L.h = 0; measAt = -1e9; } });
        } else {
            if (useGL) fresh();
            try { L.c2 = L.cv.getContext('2d', { alpha: !opaque }); } catch (e) { L.c2 = null; }
            L.scale = 0.28;
            if (L.c2) makeSprites();   // no canvas at all (a locked-down VDI): the dark stage alone
        }
        return L;
    }
    function size(L, w, h) {
        w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
        if (w === L.w && h === L.h) return;
        L.w = L.cv.width = w; L.h = L.cv.height = h; L.sig = -1;
        if (L.gl) L.gl.viewport(0, 0, w, h);
    }

    // every ~500 ms and on resize; buffers are only touched when a size changes
    function measure(now) {
        measAt = now;
        var hr = host.getBoundingClientRect(), wrap = document.querySelector('.netra-stage-blob-wrap'), r = wrap && wrap.getBoundingClientRect(), box, R, half, s, x, y;
        cssW = hr.width || window.innerWidth || 1280; cssH = hr.height || window.innerHeight || 800;
        if (r && r.width > 10) { ox = r.left + r.width / 2 - hr.left; oy = r.top + r.height / 2 - hr.top; box = Math.min(r.width, r.height); }
        else { ox = cssW * 0.5; oy = cssH * 0.39; box = Math.min(cssW, cssH) * 0.58; }
        R = Math.round(0.36 * box); half = Math.round(OK * R);
        x = Math.round(ox - half) + 'px'; y = Math.round(oy - half) + 'px'; s = O.cv.style;
        if (R !== oR || s.left !== x || s.top !== y) { oR = R; s.left = x; s.top = y; s.width = s.height = 2 * half + 'px'; }
        x = Math.min(2 * half * O.scale * 0.8, 180); size(O, x, x);
        if (G) {   // the glow keeps its pixel height on tall screens: clear of the controls, less area to composite
            y = Math.round(GH * Math.min(cssH, 820)); if (G.cv.style.height !== y + 'px') G.cv.style.height = y + 'px';
            x = Math.min(cssW * G.scale * 0.6, 320); size(G, x, x * y / cssW);
        }
    }

    // ---------- WebGL draws (uniforms only, no allocations) ----------
    function drawOrb(swell) {
        var gl = O.gl, U = O.U, lift = lvS * (0.5 * P.talk + 0.4 * P.voice), p3 = tFlow * 0.7, p2 = tFlow * 1.3;
        gl.uniform2f(U.uR, O.w, O.h);
        gl.uniform4f(U.uA, tFlow, shPh, 1 + (reduced ? 0 : 0.022 * (1 - 0.5 * P.dim) * Math.sin(brPh)), 0.14 * Math.sin(tFlow * 0.31));
        gl.uniform4f(U.uL, swell, lvS, bLo * P.voice, bHi * P.voice);
        gl.uniform4f(U.uS, P.warm, P.think, P.dim, errP);
        gl.uniform4f(U.uG, P.gain * (1 + lift * 0.25) + (reduced ? 0 : 0.05 * P.think * Math.sin(brPh * 3.5)), P.cool + 0.5 * lvS * P.talk, Math.cos(swPh), Math.sin(swPh));
        gl.uniform4f(U.uP, Math.cos(p3), Math.sin(p3), Math.cos(p2), Math.sin(p2));
        gl.uniform4f(U.uQ, Math.cos(tFlow * 0.4), Math.sin(tFlow * 0.4), Math.cos(tFlow * 0.13 + 0.8), Math.sin(tFlow * 0.13 + 0.8));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function drawGlow() {
        var gl = G.gl, U = G.U, lift = lvS * (0.55 * P.talk + 0.45 * P.voice);
        gl.uniform2f(U.uR, G.w, G.h);
        gl.uniform4f(U.uA, tFlow, GH, P.dim, errP);
        gl.uniform4f(U.uG, P.glowH + 0.08 * lift, P.glowG + 0.34 * lift, P.cool + 0.6 * lvS * P.talk, P.warm * P.voice + 0.25 * P.think);
        gl.uniform4f(U.uW, 0.24 + 0.08 * Math.sin(tFlow * 0.09), 0.78 + 0.07 * Math.sin(tFlow * 0.07 + 2), 0.3 + 0.22 * Math.sin(tFlow * 0.05), 0.72 + 0.2 * Math.sin(tFlow * 0.041 + 2));
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---------- Canvas2D fallback: pre-rendered soft light sprites, added ----------
    function sprite(rgb) {
        var n = rgb ? 64 : 128, m = n / 2, s = document.createElement('canvas'), x, g, c, i, st;
        s.width = s.height = n; x = s.getContext('2d');
        if (!x) return s;
        g = x.createRadialGradient(m, m, 0, m, m, m);
        // orb body: light centre, blue, deep rim with a lighter edge; else a soft light
        st = rgb ? [0, 1, 0.35, 0.78, 0.62, 0.34, 0.82, 0.09, 1, 0] : [0, '112,162,246,1', 0.5, '60,125,240,1', 0.78, '26,115,232,.95', 0.88, '98,158,246,.75', 0.95, '26,115,232,.25', 1, '26,115,232,0'];
        c = rgb ? 'rgba(' + rgb.join(',') + ',' : 'rgba(';
        for (i = 0; i < st.length; i += 2) g.addColorStop(st[i], c + st[i + 1] + ')');
        x.fillStyle = g; x.fillRect(0, 0, n, n);
        return s;
    }
    function makeSprites() {
        if (sprites) return;
        sprites = [];
        for (var i = 0; i < COLS.length; i++) sprites.push(sprite(COLS[i]));
    }
    function blot(c2, i, x, y, w, h, a) { if (a > 0.004) { c2.globalAlpha = a > 1 ? 1 : a; c2.drawImage(sprites[i], x - w / 2, y - h / 2, w, h); } }
    function orb2D(swell) {
        var c2 = O.c2, w = O.w, t = tFlow, cx = w / 2, cy = cx, R = w / (2 * OK) * (1 + swell) * (reduced ? 1 : 1 + 0.022 * Math.sin(brPh));
        var g = P.gain * (1 + 0.25 * lvS * (0.5 * P.talk + 0.4 * P.voice)), k = g * (1 - 0.6 * P.dim), wm = P.warm;
        c2.globalCompositeOperation = 'source-over'; c2.globalAlpha = 1; c2.fillStyle = BG; c2.fillRect(0, 0, w, w);
        c2.globalCompositeOperation = 'lighter';
        blot(c2, 0, cx, cy, R * 3.6, R * 3.6, 0.2 * k);
        blot(c2, 7, cx, cy, R * 2.12, R * 2.12, 0.74 * k);
        blot(c2, 8, cx, cy, R * 2.1, R * 2.1, 0.4 * g * P.dim);
        blot(c2, 2, cx + Math.cos(t * 0.5) * R * 0.32, cy + Math.sin(t * 0.43) * R * 0.3 - R * 0.1, R * 1.3, R * 1.3, 0.18 * k * (1 - 0.5 * wm));
        blot(c2, 3, cx + Math.cos(t * 0.37 + 2) * R * 0.34, cy + Math.sin(t * 0.51 + 2) * R * 0.32, R * 1.1, R * 1.1, 0.34 * k * (P.cool + 0.5 * lvS * P.talk));
        blot(c2, 4, cx - R * 0.3 + Math.cos(t * 0.41 + 4) * R * 0.2, cy + R * 0.25 + Math.sin(t * 0.33 + 4) * R * 0.15, R * 1.4, R * 1.4, 0.62 * k * wm);
        blot(c2, 5, cx + R * 0.35 + Math.cos(t * 0.29 + 1) * R * 0.15, cy - R * 0.35, R * 0.9, R * 0.9, 0.42 * k * wm);
        blot(c2, 6, cx + Math.sin(t * 0.31) * R * 0.14, cy - R * 0.16, R * 0.8, R * 0.8, 0.1 * k);
        if (P.think > 0.01) {
            blot(c2, 4, cx + Math.cos(swPh) * R * 0.9, cy - Math.sin(swPh) * R * 0.9, R * 0.75, R * 0.75, 0.55 * P.think);
            blot(c2, 2, cx - Math.cos(swPh) * R * 0.9, cy + Math.sin(swPh) * R * 0.9, R * 0.6, R * 0.6, 0.35 * P.think);
        }
        blot(c2, 5, cx, cy, R * 2.2, R * 2.2, 0.35 * errP);
    }
    function glow2D() {
        var c2 = G.c2, w = G.w, h = G.h, t = tFlow, lift = lvS * (0.55 * P.talk + 0.45 * P.voice), i, warm = P.warm * P.voice;
        var gh = (P.glowH + 0.08 * lift) / GH * h * 3.3, ga = (P.glowG + 0.34 * lift) * 0.5 * (1 - 0.6 * P.dim);
        c2.globalCompositeOperation = 'source-over'; c2.globalAlpha = 1; c2.clearRect(0, 0, w, h);
        c2.globalCompositeOperation = 'lighter';
        blot(c2, 0, w * 0.5, h, w * 1.5, gh * 0.9, ga * 0.7);
        for (i = 0; i < 6; i++) blot(c2, i & 1, w * (i + 0.5) / 6 + Math.sin(t * 0.2 + i * 1.9) * w * 0.06, h, w * 0.42, gh * (1 + 0.25 * Math.sin(t * 0.27 + i * 2.3)), ga * 0.7);
        blot(c2, 2, w * (0.5 + 0.1 * Math.sin(t * 0.11)), h, w * 1.2, gh * 0.55, ga * 0.6);
        blot(c2, 4, w * 0.24, h, w * 0.34, gh * 0.9, ga * 0.7 * warm);
        blot(c2, 5, w * 0.78, h, w * 0.3, gh * 0.75, ga * 0.55 * warm);
    }

    // ---------- frame ----------
    function frame(ts) {
        raf = requestAnimationFrame(frame);
        try { tick(ts); } catch (e) {}
    }
    function tick(ts) {
        var dt = lastTs ? (ts - lastTs) / 1000 : 0.016, i, k, st, lv, b, lo, hi, swell, sig, gap, dO = true, dG = true;
        lastTs = ts;
        dt = dt > 0.25 ? 0.25 : (dt < 0.001 ? 0.001 : dt);
        age += dt;
        // the glow's context starts on frame 1: GL start-up is split over two frames
        if (!G) { G = layer('left:0;top:auto;bottom:0;width:100%', FS_GLOW, ['uR', 'uA', 'uG', 'uW'], !!O.gl, false); measAt = -1e9; }
        if (ts - measAt > 500) measure(ts);

        st = window.__netraState || 'idle';
        if (st === 'error' && lastSt !== 'error') errP = 1;   // a brief rose tint, then calm
        lastSt = st;
        errP = errP > 0.001 ? errP * Math.exp(-dt / 1.4) : 0;
        targets(st);
        for (i = 0; i < KEYS.length; i++) { k = KEYS[i]; P[k] = approach(P[k], T[k], dt, 0.16, 0.16); }   // ~0.5 s crossfade

        lv = Math.min(1, Math.max(0, num(window.__netraLevel) / 100));
        if (st !== 'speaking' && st !== 'idle' && st !== 'awaiting' && st !== 'listening' && st !== 'error') lv = 0;
        b = window.__netraBands; lo = lv; hi = 0;
        if (b && b.length >= 24) {
            lo = 0;
            for (i = 0; i < 6; i++) lo += num(b[i]);
            for (i = 14; i < 24; i++) hi += num(b[i]);
            lo = Math.min(1, lo / 600); hi = Math.min(1, hi / 1000);
        }
        if (!lv) lo = hi = 0;
        lvF = approach(lvF, lv, dt, 0.07, 0.3);    // shape: fast attack, gentle release
        lvS = approach(lvS, lv, dt, 0.3, 0.75);    // large-area light: slow, never flashes at syllable rate
        bLo = approach(bLo, lo, dt, 0.06, 0.3);
        bHi = approach(bHi, hi, dt, 0.05, 0.25);
        swell = reduced ? 0 : (P.talk * 0.075 * lvF + P.voice * (0.07 * bLo + 0.05 * lvF));

        if (!reduced) {
            tFlow += dt * P.spd * 0.9; if (tFlow > 4000) tFlow -= 3600;
            shPh = (shPh + dt * (1.5 + 9 * bHi) * P.spd) % 6283.19;
            swPh = (swPh + dt * 2.6) % 6283.19;
            brPh = (brPh + dt * 1.2566 * (1 - 0.5 * P.dim)) % 6283.19;   // ~0.2 Hz breathing
            // adaptive: if most of 45 frames missed ~40 fps, repaint the slow glow less
            // often (never resize buffers here: a resize stalls software GL)
            if (age > 2) {
                if (dt > 0.025) slowN++;
                if (++winN >= 45) { if (slowN > 27 && tier < 2) tier++; winN = slowN = 0; }
            }
            k = tier ? 3 + tier : 3;
            i = 1;
            if (P.dim > 0.9) { i = 2; k = 6; }   // muted: barely moving, so half-rate saves the CPU
            frameNo++;
            dO = frameNo % i === 0;
            dG = frameNo % k === 1;
        } else {
            // calm: a composed still, redrawn only on visible change, at most ~8/s
            swPh = 0.9; tFlow = 20.5;
            sig = Math.round((lvS * 2 + P.gain + P.warm * 2 + P.think * 3 + P.dim * 4 + errP * 5 + P.cool) * 60) + O.w + G.w;
            dO = dG = sig !== O.sig && ts - lastDraw > 120;
            if (dO) O.sig = sig;
        }
        if (dO) {
            if (O.gl) drawOrb(swell); else if (O.c2) orb2D(swell);
            gap = (ts - lastDraw) / 1000; lastDraw = ts;   // fps() reports how often the orb really repaints
            if (gap > 0 && gap < 0.5) fpsEma = fpsEma ? fpsEma + (1 / gap - fpsEma) * 0.06 : 1 / gap;
        }
        if (dG) { if (G.gl) drawGlow(); else if (G.c2) glow2D(); }
    }

    function mount(el) {
        if (root) return true;
        if (!el) return false;
        try {
            host = el; css();
            reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            root = document.createElement('div'); root.className = 'ngs-stage'; root.setAttribute('aria-hidden', 'true');
            host.appendChild(root);
            targets(window.__netraState || 'boot');
            for (var i = 0; i < KEYS.length; i++) P[KEYS[i]] = T[KEYS[i]] * (KEYS[i] === 'gain' || KEYS[i] === 'glowG' ? 0.4 : 1);   // fade in
            O = layer('bottom:auto;right:auto', FS_ORB, ['uR', 'uA', 'uL', 'uS', 'uG', 'uP', 'uQ'], true, true);
            measure(performance.now());
            onVis = function () {
                if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
                else if (!raf && root) { lastTs = 0; O.sig = -1; raf = requestAnimationFrame(frame); }
            };
            document.addEventListener('visibilitychange', onVis);
            onResize = function () { measAt = -1e9; O.sig = -1; };
            window.addEventListener('resize', onResize);
            if (window.matchMedia) {
                mq = window.matchMedia('(prefers-reduced-motion: reduce)');
                onMq = function () { reduced = mq.matches; O.sig = -1; };
                if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
            }
            if (!document.hidden) raf = requestAnimationFrame(frame);
            return true;   // even with no canvas at all the stage still paints the Gemini black
        } catch (e) {
            return !!(root && root.parentNode);
        }
    }

    function unmount() {
        try {
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            if (onVis) document.removeEventListener('visibilitychange', onVis);
            if (onResize) window.removeEventListener('resize', onResize);
            if (mq && onMq) { if (mq.removeEventListener) mq.removeEventListener('change', onMq); else if (mq.removeListener) mq.removeListener(onMq); }
            if (O && O.gl && O.gl.getExtension('WEBGL_lose_context')) O.gl.getExtension('WEBGL_lose_context').loseContext();
            if (G && G.gl && G.gl.getExtension('WEBGL_lose_context')) G.gl.getExtension('WEBGL_lose_context').loseContext();
            if (root && root.parentNode) root.parentNode.removeChild(root);
        } catch (e) {}
        root = O = G = sprites = host = null; onVis = onResize = onMq = mq = null;
        lastTs = lastDraw = fpsEma = age = winN = slowN = tier = oR = 0; measAt = -1e9; lastSt = '';
    }

    function fps() { return Math.round(fpsEma); }

    return { mount: mount, unmount: unmount, fps: fps };
})();
