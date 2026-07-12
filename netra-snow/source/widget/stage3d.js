/**
 * Netra Live - 3D stage (R10.1b 'Gemini sunrise')
 *
 * the real-3D version of the blob: an iridescent glass orb (WebGL,
 * three.js r147) breathing with the same voice data as everything else.
 * The room is deliberatly cheap now - one painted sunrise billboard
 * behind the orb, a soft warm pool below it, slow camera drift + mouse
 * parallax and bloom on top. The pastel edge hues are CSS (the mesh
 * layer screens over this canvas) so they cost the GPU nothing here.
 *
 * it talks to the widget through four tiny globals the client already
 * writes every frame (no angular digests involved):
 *   window.__netraPrism  -> { h, amp }   hue engine output
 *   window.__netraBands  -> 24-band audio array or null
 *   window.__netraLevel  -> 0..100 average level
 *   window.__netraState  -> 'idle' | 'speaking' | ...
 *
 * mount() returns false when WebGL isnt available - the widget keeps the
 * 2D SVG blob in that case, nothing breaks.
 */
window.NetraStage3D = (function () {
    'use strict';

    var renderer, scene, camera, composer, bloomPass;
    var blob, blobMat, coreLight, sunrise, groundGlow;
    var coreAura, coreHeart, coreTex = {}, coreKey = '', corePulse = 0;
    var smoke = [], beatEnv = 0, lastBass = 0;   // R13 - edge smoke + beat glow
    var rafId = null, clockT = 0, lastTs = 0, host = null;
    var mouse = { x: 0, y: 0 };
    var reduceMotion = false;
    var uniforms = null;
    var speechMix = 0.25;
    var slowFrames = 0, degraded = false;
    var fpsEma = 60;   // R12 - rolling fps, surfaced in Netra Lab

    // ashima 3D simplex noise, the usual GLSL snippet
    var SNOISE = [
        'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
        'vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}',
        'vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}',
        'vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}',
        'float snoise(vec3 v){',
        'const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);',
        'vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);',
        'vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);',
        'vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;',
        'i=mod289(i);',
        'vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));',
        'float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;',
        'vec4 j=p-49.0*floor(p*ns.z*ns.z);',
        'vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);',
        'vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);',
        'vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);',
        'vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));',
        'vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;',
        'vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);',
        'vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));',
        'p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;',
        'vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;',
        'return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}'
    ].join('\n');

    function prism()  { return window.__netraPrism || { h: 152, amp: 0 }; }
    function bandAvg(from, to) {
        var b = window.__netraBands;
        if (!b) return (window.__netraLevel || 0) / 100;
        var s = 0, n = 0;
        for (var i = from; i <= to && i < b.length; i++) { s += b[i]; n++; }
        return n ? (s / n) / 100 : 0;
    }

    // a painted "studio" for the glass to refract: dark violet room with a
    // few bright soft light blobs. becomes the PMREM environment map.
    function makeEnvTexture() {
        var cv = document.createElement('canvas');
        cv.width = 1024; cv.height = 512;
        var g = cv.getContext('2d');
        // R10.1b - the room got a big lift: it used to fade to near-black
        // and the orb's rim mirrored that at grazing angles = ugly dark
        // crescents around the silhouette. A brighter violet room + a warm
        // horizon band keep the fresnel edge luminous all the way round.
        var grad = g.createLinearGradient(0, 0, 0, 512);
        grad.addColorStop(0, '#4a3573');
        grad.addColorStop(0.55, '#3a2760');
        grad.addColorStop(1, '#2a1c4e');
        g.fillStyle = grad;
        g.fillRect(0, 0, 1024, 512);
        var horizon = g.createLinearGradient(0, 250, 0, 420);
        horizon.addColorStop(0, 'rgba(255, 190, 140, 0)');
        horizon.addColorStop(0.6, 'rgba(255, 175, 130, 0.35)');
        horizon.addColorStop(1, 'rgba(210, 120, 120, 0.15)');
        g.fillStyle = horizon;
        g.fillRect(0, 250, 1024, 170);
        function light(x, y, r, color, a) {
            var rg = g.createRadialGradient(x, y, 0, x, y, r);
            rg.addColorStop(0, color);
            rg.addColorStop(1, 'rgba(0,0,0,0)');
            g.globalAlpha = a;
            g.fillStyle = rg;
            g.fillRect(x - r, y - r, r * 2, r * 2);
            g.globalAlpha = 1;
        }
        light(240, 110, 190, '#ffffff', 0.72);   // key light (dimmed - it was washing the glass white)
        light(790, 150, 230, '#4285F4', 0.8);    // gemini azure fill
        light(520, 400, 260, '#AD89EB', 0.6);    // gemini lavender bounce
        light(60,  330, 170, '#D96570', 0.45);   // gemini rose kicker
        light(512, 470, 300, '#ffd9a0', 0.5);    // sunrise from below
        var tex = new THREE.CanvasTexture(cv);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        return tex;
    }

    function makeBlob() {
        var BASE_SCALE = 0.75;   // R10.1 - 25% smaller per user
        // R12 perf - detail 24 instead of 32: ~45% fewer verts for the
        // displacement shader to push, zero visible smoothness lost at
        // this on-screen size
        var geo = new THREE.IcosahedronGeometry(1.05, 24);
        // R10.1b - the glass reads GEMINI now, not white: a faint blue base
        // tint, much shorter attenuation (long light paths through the rim
        // soak up the hue instead of showing the dark sky refracted = no
        // more black notches on the silhouette) and a gentler ior/thickness
        // so the edges dont bend rays clean off the sunrise plane.
        blobMat = new THREE.MeshPhysicalMaterial({
            color: 0xdfe8ff,
            metalness: 0.0,
            roughness: 0.12,
            transmission: 0.88,
            thickness: 0.65,
            ior: 1.29,
            iridescence: 1.0,
            iridescenceIOR: 1.32,
            iridescenceThicknessRange: [120, 480],
            clearcoat: 0.85,
            clearcoatRoughness: 0.18,
            envMapIntensity: 1.7,
            attenuationDistance: 1.4,
            attenuationColor: new THREE.Color().setHSL(0.62, 0.8, 0.55),
            emissive: new THREE.Color().setHSL(0.62, 0.9, 0.35),
            emissiveIntensity: 0.28
        });
        uniforms = {
            uTime:  { value: 0 },
            uBass:  { value: 0 },
            uTre:   { value: 0 },
            uSpeech:{ value: 0.25 }
        };
        blobMat.onBeforeCompile = function (shader) {
            shader.uniforms.uTime = uniforms.uTime;
            shader.uniforms.uBass = uniforms.uBass;
            shader.uniforms.uTre = uniforms.uTre;
            shader.uniforms.uSpeech = uniforms.uSpeech;
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>',
                    '#include <common>\nuniform float uTime;uniform float uBass;uniform float uTre;uniform float uSpeech;\n' + SNOISE)
                .replace('#include <begin_vertex>', [
                    '#include <begin_vertex>',
                    'float nA = snoise(normal * 1.7 + vec3(0.0, uTime * 0.32, 0.0));',
                    'float nB = snoise(normal * 4.6 - vec3(uTime * 0.55));',
                    'float disp = nA * (0.08 + uBass * 0.15) + nB * (0.02 + uTre * 0.10);',
                    'transformed += normal * disp * (0.5 + uSpeech * 0.6);'
                ].join('\n'));
        };
        blob = new THREE.Mesh(geo, blobMat);
        blob.position.y = 0.68;
        blob.scale.setScalar(BASE_SCALE);
        scene.add(blob);

        // R12 - the heart is no longer one flat glow: it is a pair of
        // camera-facing sprites painted with MULTI-HUE radial gradients, so
        // colour literally starts in the middle and diffuses out through
        // the glass. One palette per mood - gemini while she talks/idles,
        // GREEN while she listens, violet while she thinks.
        function bakeRadial(stops) {
            var cv = document.createElement('canvas');
            cv.width = 256; cv.height = 256;
            var g = cv.getContext('2d');
            var rg = g.createRadialGradient(128, 128, 6, 128, 128, 126);
            for (var i = 0; i < stops.length; i++) rg.addColorStop(stops[i][0], stops[i][1]);
            g.fillStyle = rg;
            g.fillRect(0, 0, 256, 256);
            return new THREE.CanvasTexture(cv);
        }
        // R12.1 - MORE colour from the middle: tighter, more saturated
        // rings so distinct hues actually read through the glass instead
        // of blurring into one pastel
        coreTex.gemini = bakeRadial([
            [0.00, 'rgba(255,244,214,1.0)'],
            [0.16, 'rgba(255,196,120,0.95)'],
            [0.34, 'rgba(66,133,244,0.95)'],
            [0.52, 'rgba(155,114,203,0.80)'],
            [0.72, 'rgba(233,86,138,0.45)'],
            [1.00, 'rgba(233,86,138,0)']
        ]);
        coreTex.green = bakeRadial([
            [0.00, 'rgba(238,255,242,1.0)'],
            [0.18, 'rgba(140,255,190,0.95)'],
            [0.38, 'rgba(36,214,130,0.90)'],
            [0.60, 'rgba(16,180,150,0.60)'],
            [0.82, 'rgba(30,140,190,0.30)'],
            [1.00, 'rgba(30,140,190,0)']
        ]);
        coreTex.violet = bakeRadial([
            [0.00, 'rgba(248,242,255,1.0)'],
            [0.18, 'rgba(196,160,255,0.95)'],
            [0.40, 'rgba(150,100,245,0.85)'],
            [0.64, 'rgba(96,70,220,0.50)'],
            [0.85, 'rgba(66,133,244,0.25)'],
            [1.00, 'rgba(66,133,244,0)']
        ]);
        function makeGlowSprite(scale, opacity) {
            var m = new THREE.SpriteMaterial({
                map: coreTex.gemini, transparent: true, opacity: opacity,
                blending: THREE.AdditiveBlending, depthWrite: false
            });
            var s = new THREE.Sprite(m);
            s.position.copy(blob.position);
            s.scale.setScalar(scale);
            scene.add(s);
            return s;
        }
        coreHeart = makeGlowSprite(1.2, 0.95);    // bright multi-hue center
        coreHeart.material.toneMapped = false;    // let the colours punch through the glass
        coreAura  = makeGlowSprite(2.3, 0.38);    // wide diffusion halo
        coreKey = 'gemini';

        coreLight = new THREE.PointLight(0x9a5cff, 1.4, 10, 2);
        coreLight.position.copy(blob.position);
        scene.add(coreLight);
    }

    // R12 - which gradient palette belongs to which mood
    function coreKeyFor(st) {
        if (st === 'listening' || st === 'awaiting') return 'green';
        if (st === 'thinking') return 'violet';
        return 'gemini';
    }

    // R13 - SMOKE. Soft wisps hugging the orb's edge that diffuse outward
    // as she talks: violet smoke while SPEAKING, a greenish haze around
    // the whole perimeter while LISTENING, and every strong beat of voice
    // makes the wisps glow and push out a little further.
    function makeSmokeTexture() {
        var cv = document.createElement('canvas');
        cv.width = 128; cv.height = 128;
        var g = cv.getContext('2d');
        function puff(x, y, r, a) {
            var rg = g.createRadialGradient(x, y, 1, x, y, r);
            rg.addColorStop(0, 'rgba(255,255,255,' + a + ')');
            rg.addColorStop(0.55, 'rgba(255,255,255,' + (a * 0.35) + ')');
            rg.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = rg;
            g.fillRect(0, 0, 128, 128);
        }
        puff(64, 64, 60, 0.55);
        puff(46, 52, 34, 0.5);
        puff(82, 58, 30, 0.45);
        puff(58, 84, 30, 0.4);
        puff(78, 82, 24, 0.35);
        return new THREE.CanvasTexture(cv);
    }
    function makeSmoke() {
        var tex = makeSmokeTexture();
        for (var i = 0; i < 14; i++) {
            var m = new THREE.SpriteMaterial({
                map: tex, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false
            });
            var s = new THREE.Sprite(m);
            var ang = (i / 14) * Math.PI * 2;
            s.userData = {
                ang: ang,
                drift: 0.10 + (i % 5) * 0.035,       // slow orbit, staggered
                wob: 0.5 + (i % 4) * 0.31,            // per-wisp bob phase
                scl: 0.55 + (i % 3) * 0.22
            };
            s.position.copy(blob.position);
            scene.add(s);
            smoke.push(s);
        }
    }

    // R10.1 - SUNRISE. A golden-hour glow rising behind the blob: one big
    // painted billboard (sky + sun) and a soft warm pool of light under
    // the orb. Two draw calls total - this REPLACED the mirror floor and
    // the 3D starfield, which together were most of the frame cost.
    function makeSunrise() {
        var cv = document.createElement('canvas');
        cv.width = 1024; cv.height = 640;
        var g = cv.getContext('2d');
        // R10.1b pulled the sky ~35% darker; R12 dials it ANOTHER 15% down
        // per Mihir - the room goes properly moody and the blob (which
        // keeps its own light) pops out of it even harder.
        var sky = g.createLinearGradient(0, 0, 0, 640);
        sky.addColorStop(0.0, '#0e0a1f');
        sky.addColorStop(0.5, '#17112d');
        sky.addColorStop(0.75, '#2f1d3c');
        sky.addColorStop(0.9, '#3a2542');
        sky.addColorStop(1.0, '#463030');
        g.fillStyle = sky;
        g.fillRect(0, 0, 1024, 640);
        // R13 - the sun moved to the TOP RIGHT per Mihir (was sitting low
        // behind her like a horizon sunrise)
        var sun = g.createRadialGradient(816, 104, 10, 816, 104, 500);
        sun.addColorStop(0.0, 'rgba(255, 240, 205, 0.7)');
        sun.addColorStop(0.16, 'rgba(255, 205, 140, 0.42)');
        sun.addColorStop(0.4, 'rgba(240, 140, 105, 0.24)');
        sun.addColorStop(0.7, 'rgba(200, 95, 115, 0.12)');
        sun.addColorStop(1.0, 'rgba(155, 114, 203, 0)');
        g.fillStyle = sun;
        g.fillRect(0, 0, 1024, 640);
        var tex = new THREE.CanvasTexture(cv);
        var mat = new THREE.MeshBasicMaterial({ map: tex });
        // bigger than the view on purpose: refracted rays through the orb's
        // rim must still land ON the plane, never on the void behind it
        sunrise = new THREE.Mesh(new THREE.PlaneGeometry(38, 23.75), mat);
        sunrise.position.set(0, 1.6, -8);
        scene.add(sunrise);

        // warm pool of light under the orb instead of the mirror
        var cv2 = document.createElement('canvas');
        cv2.width = 512; cv2.height = 512;
        var g2 = cv2.getContext('2d');
        var rg = g2.createRadialGradient(256, 256, 10, 256, 256, 250);
        rg.addColorStop(0, 'rgba(255, 214, 160, 0.17)');
        rg.addColorStop(0.5, 'rgba(217, 120, 130, 0.07)');
        rg.addColorStop(1, 'rgba(0, 0, 0, 0)');
        g2.fillStyle = rg;
        g2.fillRect(0, 0, 512, 512);
        // tone-mapped now - the unmapped version turned into a blown-white
        // streak behind the mic buttons once bloom got hold of it
        groundGlow = new THREE.Mesh(
            new THREE.PlaneGeometry(9, 9),
            new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv2), transparent: true, depthWrite: false })
        );
        groundGlow.rotation.x = -Math.PI / 2;
        groundGlow.position.y = -1.2;
        scene.add(groundGlow);

        // warm key so the glass rim catches the sun - from the top right,
        // matching where the sun sits in the sky now
        var sunLight = new THREE.DirectionalLight(0xffc98a, 0.42);
        sunLight.position.set(4.5, 4.5, -2.5);
        sunLight.target = blob;
        scene.add(sunLight);
    }

    function onMouse(ev) {
        var w = window.innerWidth, h = window.innerHeight;
        mouse.x = (ev.clientX / w) * 2 - 1;
        mouse.y = (ev.clientY / h) * 2 - 1;
    }

    function frame(ts) {
        rafId = requestAnimationFrame(frame);
        var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
        lastTs = ts;
        clockT += dt;

        var p = prism();
        var st = window.__netraState || 'idle';
        var amp = p.amp || 0;
        var hue = ((p.h || 152) % 360) / 360;

        var speechTarget = st === 'speaking' ? 1 : (st === 'thinking' ? 0.55 : 0.25);
        speechMix += (speechTarget - speechMix) * 0.05;

        uniforms.uTime.value = clockT;
        uniforms.uBass.value += (bandAvg(0, 4) - uniforms.uBass.value) * 0.25;
        uniforms.uTre.value  += (bandAvg(16, 23) - uniforms.uTre.value) * 0.25;
        uniforms.uSpeech.value = speechMix;

        // hue-linked glass (emissive rides the hue too so the body of the
        // glass actually LOOKS coloured instead of washed white)
        blobMat.attenuationColor.setHSL(hue, 0.8, 0.5);
        blobMat.emissive.setHSL(hue, 0.85, 0.4);
        blobMat.emissiveIntensity = 0.24 + amp * 0.35;

        // R12 - swap the heart's gradient palette with the mood (green when
        // she listens, violet thinking, gemini otherwise) with a short
        // brightness dip so the change lands soft, not like a light switch
        var wantKey = coreKeyFor(st);
        if (wantKey !== coreKey) {
            coreKey = wantKey;
            coreHeart.material.map = coreTex[coreKey];
            coreAura.material.map  = coreTex[coreKey];
            coreHeart.material.needsUpdate = true;
            coreAura.material.needsUpdate = true;
            corePulse = 1;
        }
        if (corePulse > 0) corePulse = Math.max(0, corePulse - dt * 3.2);
        var dip = 1 - corePulse * 0.55;
        var breath = Math.sin(clockT * 2.2) * 0.04;
        coreHeart.material.opacity = (0.72 + amp * 0.28) * dip;
        coreAura.material.opacity  = (0.28 + amp * 0.32) * dip;
        coreHeart.scale.setScalar(1.2 * (1 + amp * 0.45 + breath));
        coreAura.scale.setScalar(2.3 * (1 + amp * 0.30 + breath * 0.6));
        coreLight.color.setHSL(hue, 0.85, 0.6);
        coreLight.intensity = 1.0 + amp * 2.6;

        blob.rotation.y += dt * 0.12;
        blob.rotation.z = Math.sin(clockT * 0.15) * 0.08;
        var bs = 0.75 * (1 + amp * 0.10);
        blob.scale.setScalar(bs);

        // R13 - SMOKE around the edge. Beat detector first: a rising bass
        // edge = one "beat" -> the wisps flash and push outward, then decay.
        var bass = bandAvg(0, 4);
        if (bass - lastBass > 0.09) beatEnv = 1;
        lastBass += (bass - lastBass) * 0.3;
        beatEnv = Math.max(0, beatEnv - dt * 2.6);
        var speaking = (st === 'speaking');
        var hearing  = (st === 'listening' || st === 'awaiting');
        // violet smoke when SHE talks, greenish haze when she hears YOU,
        // barely-there neutral wisps otherwise
        var smokeBase = speaking ? 0.16 : (hearing ? 0.13 : 0.05);
        var smokeHue  = speaking ? 0.74 : (hearing ? 0.36 : hue);
        var smokeSat  = (speaking || hearing) ? 0.75 : 0.35;
        for (var si = 0; si < smoke.length; si++) {
            var sp = smoke[si], ud = sp.userData;
            ud.ang += dt * ud.drift * (1 + amp * 0.8);
            var breathe = Math.sin(clockT * 0.7 + ud.wob * 7) * 0.06;
            var rad = 0.84 + breathe + amp * 0.34 + beatEnv * 0.16;   // diffuse outward with the voice
            sp.position.set(
                blob.position.x + Math.cos(ud.ang) * rad,
                blob.position.y + Math.sin(ud.ang) * rad * 0.9,
                blob.position.z + Math.sin(ud.ang * 2 + ud.wob) * 0.25
            );
            sp.scale.setScalar(ud.scl * (1 + amp * 0.7 + beatEnv * 0.5));
            sp.material.opacity = smokeBase * (0.6 + 0.4 * Math.sin(clockT * 0.9 + ud.wob * 9))
                                + amp * 0.22 + beatEnv * 0.18;
            sp.material.color.setHSL(smokeHue, smokeSat, 0.55 + beatEnv * 0.2);
        }

        if (!reduceMotion) {
            var cx = Math.sin(clockT * 0.1) * 0.18 + mouse.x * 0.45;
            var cy = 0.42 + Math.sin(clockT * 0.07) * 0.06 - mouse.y * 0.28;
            camera.position.x += (cx - camera.position.x) * 0.035;
            camera.position.y += (cy - camera.position.y) * 0.035;
            camera.lookAt(0, 0.45, 0);
        }

        if (bloomPass) bloomPass.strength = (degraded ? 0 : 0.4) + amp * 0.7 * (degraded ? 0 : 1);

        if (composer && !degraded) composer.render();
        else renderer.render(scene, camera);

        // adaptive insurance: if we cant hold ~30fps, drop bloom + dpr once
        if (dt > 0.033) { if (++slowFrames > 90 && !degraded) degrade(); }
        else if (slowFrames > 0) slowFrames--;
        fpsEma += ((1 / Math.max(dt, 0.001)) - fpsEma) * 0.05;
        window.__netra3dFps = Math.round(fpsEma);
    }

    function degrade() {
        degraded = true;
        try { renderer.setPixelRatio(1); } catch (e) {}
        resize();
    }

    function resize() {
        if (!host || !renderer) return;
        var w = host.clientWidth || window.innerWidth;
        var h = host.clientHeight || window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        if (composer) composer.setSize(w, h);
    }

    function mount(el) {
        if (renderer) return true;   // already mounted
        if (!window.THREE) return false;
        host = el;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        } catch (e) { renderer = null; return false; }
        try {
            reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));   // R12 perf - 1.5 -> 1.35, ~22% fewer shaded pixels
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.02;
            host.appendChild(renderer.domElement);

            scene = new THREE.Scene();
            // matched to the darkened sky mid-tones - if a refracted ray
            // somehow still misses the sunrise plane it lands on a colour
            // that blends in instead of a black notch
            scene.background = new THREE.Color(0x19122e);
            camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
            camera.position.set(0, 0.42, 5.4);
            camera.lookAt(0, 0.45, 0);

            var pmrem = new THREE.PMREMGenerator(renderer);
            scene.environment = pmrem.fromEquirectangular(makeEnvTexture()).texture;

            makeBlob();
            makeSunrise();
            makeSmoke();

            // gentle fill so nothing goes pitch black off-reflection
            scene.add(new THREE.AmbientLight(0x33224d, 0.45));
            var rim = new THREE.DirectionalLight(0xAD89EB, 0.6);
            rim.position.set(-3, 4, -4);
            scene.add(rim);
            var key = new THREE.PointLight(0xeaf2ff, 0.85, 30);
            key.position.set(3.5, 3.2, 3.5);
            scene.add(key);
            var kick = new THREE.PointLight(0x4285F4, 0.7, 24);
            kick.position.set(-3.2, -0.5, 2.8);
            scene.add(kick);

            composer = new THREE.EffectComposer(renderer);
            composer.addPass(new THREE.RenderPass(scene, camera));
            bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.5, 0.8);
            composer.addPass(bloomPass);

            resize();
            if (window.ResizeObserver) new ResizeObserver(resize).observe(host);
            else window.addEventListener('resize', resize);
            window.addEventListener('mousemove', onMouse, { passive: true });
            document.addEventListener('visibilitychange', function () {
                if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = null; lastTs = 0; }
                else if (!rafId) rafId = requestAnimationFrame(frame);
            });
            rafId = requestAnimationFrame(frame);
            return true;
        } catch (e2) {
            try { if (renderer) { renderer.dispose(); if (renderer.domElement && renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement); } } catch (e3) {}
            renderer = null;
            return false;
        }
    }

    function unmount() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        window.removeEventListener('mousemove', onMouse);
        try {
            if (renderer) {
                renderer.dispose();
                if (renderer.domElement && renderer.domElement.parentNode) {
                    renderer.domElement.parentNode.removeChild(renderer.domElement);
                }
            }
        } catch (e) {}
        renderer = null; scene = null; composer = null;
    }

    return { mount: mount, unmount: unmount };
})();
