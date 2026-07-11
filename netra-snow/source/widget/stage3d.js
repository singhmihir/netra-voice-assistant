/**
 * Netra Live - 3D stage (R10)
 *
 * the real-3D version of the blob: an iridescent glass orb (WebGL,
 * three.js r147) breathing with the same voice data as everything else,
 * sitting in a proper scene - parallax starfield, dust motes, a soft
 * reflective floor, slow camera drift + mouse parallax, bloom on top.
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
    var blob, blobMat, core, coreLight, stars, dust, dustGroup, reflector, fadeDisk;
    var rafId = null, clockT = 0, lastTs = 0, host = null;
    var mouse = { x: 0, y: 0 };
    var reduceMotion = false;
    var uniforms = null;
    var speechMix = 0.25;
    var slowFrames = 0, degraded = false;

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
        var grad = g.createLinearGradient(0, 0, 0, 512);
        grad.addColorStop(0, '#241238');
        grad.addColorStop(0.55, '#120826');
        grad.addColorStop(1, '#060312');
        g.fillStyle = grad;
        g.fillRect(0, 0, 1024, 512);
        function light(x, y, r, color, a) {
            var rg = g.createRadialGradient(x, y, 0, x, y, r);
            rg.addColorStop(0, color);
            rg.addColorStop(1, 'rgba(0,0,0,0)');
            g.globalAlpha = a;
            g.fillStyle = rg;
            g.fillRect(x - r, y - r, r * 2, r * 2);
            g.globalAlpha = 1;
        }
        light(240, 110, 190, '#ffffff', 0.95);   // key light
        light(790, 150, 230, '#b28cff', 0.75);   // violet fill
        light(520, 400, 260, '#3fd4c0', 0.45);   // teal bounce
        light(60,  330, 170, '#ffb46b', 0.5);    // amber kicker
        var tex = new THREE.CanvasTexture(cv);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        return tex;
    }

    function makeBlob() {
        var geo = new THREE.IcosahedronGeometry(1.05, 48);
        blobMat = new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            metalness: 0.0,
            roughness: 0.12,
            transmission: 0.88,
            thickness: 0.9,
            ior: 1.38,
            iridescence: 1.0,
            iridescenceIOR: 1.32,
            iridescenceThicknessRange: [120, 480],
            clearcoat: 0.85,
            clearcoatRoughness: 0.18,
            envMapIntensity: 2.3,
            attenuationDistance: 3.2,
            attenuationColor: new THREE.Color().setHSL(0.7, 0.7, 0.72),
            emissive: new THREE.Color().setHSL(0.7, 0.9, 0.35),
            emissiveIntensity: 0.55
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
        blob.position.y = 0.55;
        scene.add(blob);

        // glowing heart inside the glass
        core = new THREE.Mesh(
            new THREE.SphereGeometry(0.55, 48, 48),
            new THREE.MeshBasicMaterial({
                color: 0x9a5cff, transparent: true, opacity: 0.95,
                blending: THREE.AdditiveBlending, depthWrite: false,
                toneMapped: false
            })
        );
        core.position.copy(blob.position);
        scene.add(core);

        coreLight = new THREE.PointLight(0x9a5cff, 1.4, 10, 2);
        coreLight.position.copy(blob.position);
        scene.add(coreLight);
    }

    function makeStars() {
        function shell(count, rMin, rMax, size, color, opacity) {
            var pos = new Float32Array(count * 3);
            for (var i = 0; i < count; i++) {
                var r = rMin + Math.random() * (rMax - rMin);
                var th = Math.random() * Math.PI * 2;
                var ph = Math.acos(2 * Math.random() - 1);
                pos[i * 3]     = r * Math.sin(ph) * Math.cos(th);
                pos[i * 3 + 1] = r * Math.cos(ph) * 0.7;
                pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
            }
            var g2 = new THREE.BufferGeometry();
            g2.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            var m2 = new THREE.PointsMaterial({
                size: size, sizeAttenuation: true, color: color,
                transparent: true, opacity: opacity,
                blending: THREE.AdditiveBlending, depthWrite: false
            });
            return new THREE.Points(g2, m2);
        }
        stars = shell(1600, 16, 42, 0.07, 0xbfd0ff, 0.75);
        scene.add(stars);
        dustGroup = new THREE.Group();
        dust = shell(140, 1.9, 3.4, 0.05, 0xd8c2ff, 0.5);
        dustGroup.add(dust);
        dustGroup.position.y = 0.55;
        scene.add(dustGroup);
    }

    function makeFloor() {
        try {
            reflector = new THREE.Reflector(new THREE.CircleGeometry(7, 48), {
                textureWidth: 512, textureHeight: 512, color: 0x556, clipBias: 0.003
            });
            reflector.rotation.x = -Math.PI / 2;
            reflector.position.y = -1.4;
            scene.add(reflector);
        } catch (e) { /* floor is decoration - never fatal */ }
        // radial fade so the mirror melts into the room instead of ending
        // in a hard circle
        var cv = document.createElement('canvas');
        cv.width = 512; cv.height = 512;
        var g = cv.getContext('2d');
        var rg = g.createRadialGradient(256, 256, 40, 256, 256, 256);
        rg.addColorStop(0, 'rgba(8,3,18,0.55)');
        rg.addColorStop(0.55, 'rgba(8,3,18,0.85)');
        rg.addColorStop(1, 'rgba(8,3,18,1)');
        g.fillStyle = rg;
        g.fillRect(0, 0, 512, 512);
        fadeDisk = new THREE.Mesh(
            new THREE.CircleGeometry(7.05, 48),
            new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false })
        );
        fadeDisk.rotation.x = -Math.PI / 2;
        fadeDisk.position.y = -1.395;
        scene.add(fadeDisk);
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

        // hue-linked glass + heart
        blobMat.attenuationColor.setHSL(hue, 0.75, 0.5);
        core.material.color.setHSL(hue, 0.9, 0.65);
        core.material.opacity = 0.55 + amp * 0.45;
        var cs = 1 + amp * 0.5 + Math.sin(clockT * 2.2) * 0.03;
        core.scale.setScalar(cs);
        coreLight.color.copy(core.material.color);
        coreLight.intensity = 1.0 + amp * 2.6;

        blob.rotation.y += dt * 0.12;
        blob.rotation.z = Math.sin(clockT * 0.15) * 0.08;
        var bs = 1 + amp * 0.10;
        blob.scale.setScalar(bs);

        stars.rotation.y += dt * 0.006;
        dustGroup.rotation.y -= dt * 0.03;
        dustGroup.rotation.x = Math.sin(clockT * 0.11) * 0.1;

        if (!reduceMotion) {
            var cx = Math.sin(clockT * 0.1) * 0.18 + mouse.x * 0.45;
            var cy = 0.42 + Math.sin(clockT * 0.07) * 0.06 - mouse.y * 0.28;
            camera.position.x += (cx - camera.position.x) * 0.035;
            camera.position.y += (cy - camera.position.y) * 0.035;
            camera.lookAt(0, 0.45, 0);
        }

        if (bloomPass) bloomPass.strength = (degraded ? 0 : 0.45) + amp * 1.05 * (degraded ? 0 : 1);

        if (composer && !degraded) composer.render();
        else renderer.render(scene, camera);

        // adaptive insurance: if we cant hold ~30fps, drop bloom + dpr once
        if (dt > 0.033) { if (++slowFrames > 90 && !degraded) degrade(); }
        else if (slowFrames > 0) slowFrames--;
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
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.35;
            host.appendChild(renderer.domElement);

            scene = new THREE.Scene();
            scene.background = new THREE.Color(0x080312);
            camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
            camera.position.set(0, 0.42, 5.4);
            camera.lookAt(0, 0.45, 0);

            var pmrem = new THREE.PMREMGenerator(renderer);
            scene.environment = pmrem.fromEquirectangular(makeEnvTexture()).texture;

            makeBlob();
            makeStars();
            makeFloor();

            // gentle fill so the floor + dust arent pitch black off-reflection
            scene.add(new THREE.AmbientLight(0x33224d, 0.6));
            var rim = new THREE.DirectionalLight(0x8877ff, 0.7);
            rim.position.set(-3, 4, -4);
            scene.add(rim);
            var key = new THREE.PointLight(0xffffff, 1.1, 30);
            key.position.set(3.5, 3.2, 3.5);
            scene.add(key);
            var kick = new THREE.PointLight(0x51e6c8, 0.7, 24);
            kick.position.set(-3.2, -0.5, 2.8);
            scene.add(kick);

            composer = new THREE.EffectComposer(renderer);
            composer.addPass(new THREE.RenderPass(scene, camera));
            bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.6, 0.6, 0.62);
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
