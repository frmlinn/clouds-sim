// ============================================================================
// UTILS
// ============================================================================
const ColorUtils = {
    sRGBtoLinear: (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
    
    hexToRgbLinear: (hex) => {
        const bigint = parseInt(hex.substring(1), 16);
        return [
            ColorUtils.sRGBtoLinear(((bigint >> 16) & 255) / 255),
            ColorUtils.sRGBtoLinear(((bigint >> 8) & 255) / 255),
            ColorUtils.sRGBtoLinear((bigint & 255) / 255)
        ];
    }
};

const MathUtils = {
    halton: (index, base) => {
        let result = 0;
        let f = 1 / base;
        let i = index;
        while (i > 0) {
            result = result + f * (i % base);
            i = Math.floor(i / base);
            f = f / base;
        }
        return result;
    }
};

// ============================================================================
// VOLUMETRIC CLOUD ENGINE
// ============================================================================
class CloudEngine {
    constructor(canvas, gl, shaders, noiseTex, detailTex, blueNoiseTex) {
        this.canvas = canvas;
        this.gl = gl;
        
        // Textures
        this.noiseTex = noiseTex;
        this.detailTex = detailTex;
        this.blueNoiseTex = blueNoiseTex;
        
        // Shader Programs
        this.progCloud = shaders.cloud;
        this.progTAA = shaders.taa;
        this.progShadow = shaders.shadow;
        this.progDisplay = shaders.display;
        
        // Camera and Physics State
        this.cam = { theta: 0.5, phi: 0.8, radius: 14.0 };
        this.sunDir = { x: 0.0, y: 1.0, z: 0.0 };
        this.wind = { x: 0, z: 0 };
        
        // UI Settings Cache
        this.settings = {
            coverage: 0.55,
            densityMult: 11.0,
            baseScale: 1.8,
            detailScale: 5.0,
            detailWeight: 0.3,
            lightAbsorb: 1.3,
            scattering: 0.95,
            steps: 50,
            windGlobal: 0.3,
            skyColor: ColorUtils.hexToRgbLinear("#1e293b"),
            cloudColor: [1.0, 1.0, 1.0]
        };

        // Engine State
        this.state = {
            isPaused: false,
            isDragging: false,
            isDraggingGimbal: false,
            resScale: 0.5,
            pingPong: true,
            globalFrame: 0,
            lastTime: performance.now(),
            fpsCounter: 0,
            lastFpsTime: performance.now()
        };

        this.initGeometry();
        this.initUniformLocations();
        this.initFBOs();
        
        this.syncSettingsFromUI();
        this.bindAllEvents();
        
        this.resize();
        requestAnimationFrame((now) => this.render(now));
    }

    // --- INITIALIZATION ---

    initGeometry() {
        // Fullscreen quad for post-processing passes
        this.posBuf = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.posBuf);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,   1, -1,  -1,  1,
            -1,  1,   1, -1,   1,  1
        ]), this.gl.STATIC_DRAW);
    }

    initUniformLocations() {
        const getLoc = (prog, name) => this.gl.getUniformLocation(prog, name);

        this.uCloud = {
            res: getLoc(this.progCloud, "u_resolution"),
            jitter: getLoc(this.progCloud, "u_jitter"),
            time: getLoc(this.progCloud, "u_time"),
            frame: getLoc(this.progCloud, "u_frame"), 
            camPos: getLoc(this.progCloud, "u_camPos"),
            camTarget: getLoc(this.progCloud, "u_camTarget"),
            boxSize: getLoc(this.progCloud, "u_boxSize"),
            noiseTex: getLoc(this.progCloud, "u_noiseTex"),
            detailTex: getLoc(this.progCloud, "u_detailTex"),
            shadowTex: getLoc(this.progCloud, "u_shadowTex"),
            blueNoiseTex: getLoc(this.progCloud, "u_blueNoiseTex"),
            baseScale: getLoc(this.progCloud, "u_baseScale"),
            coverage: getLoc(this.progCloud, "u_coverage"),
            densityMult: getLoc(this.progCloud, "u_densityMult"),
            detailScale: getLoc(this.progCloud, "u_detailScale"),
            detailWeight: getLoc(this.progCloud, "u_detailWeight"),
            lightAbsorb: getLoc(this.progCloud, "u_lightAbsorb"),
            scattering: getLoc(this.progCloud, "u_scattering"),
            sunDir: getLoc(this.progCloud, "u_sunDir"),
            cloudColor: getLoc(this.progCloud, "u_cloudColor"),
            skyColor: getLoc(this.progCloud, "u_skyColor"),
            steps: getLoc(this.progCloud, "u_steps"),
            windOffset: getLoc(this.progCloud, "u_windOffset")
        };

        this.uShadow = {
            boxSize: getLoc(this.progShadow, "u_boxSize"),
            sunDir: getLoc(this.progShadow, "u_sunDir"),
            noiseTex: getLoc(this.progShadow, "u_noiseTex"),
            detailTex: getLoc(this.progShadow, "u_detailTex"), 
            baseScale: getLoc(this.progShadow, "u_baseScale"),
            coverage: getLoc(this.progShadow, "u_coverage"),
            densityMult: getLoc(this.progShadow, "u_densityMult"),
            detailScale: getLoc(this.progShadow, "u_detailScale"),
            detailWeight: getLoc(this.progShadow, "u_detailWeight"),
            windOffset: getLoc(this.progShadow, "u_windOffset")
        };

        this.uTAA = {
            currentTex: getLoc(this.progTAA, "u_currentTex"),
            historyTex: getLoc(this.progTAA, "u_historyTex"),
            blendFactor: getLoc(this.progTAA, "u_blendFactor")
        };

        this.uDisplay = {
            tex: getLoc(this.progDisplay, "u_tex")
        };
    }

    initFBOs() {
        // TAA History Buffers
        this.fboPing = GLUtils.createFBO(this.gl, 1, 1);
        this.fboPong = GLUtils.createFBO(this.gl, 1, 1);
        // High precision 2D shadow map (R16F)
        this.fboShadow = GLUtils.createFBO(this.gl, 512, 512, this.gl.R16F, this.gl.RED, this.gl.HALF_FLOAT); 
        // Current frame raw output
        this.fboCurrent = GLUtils.createFBO(this.gl, 1, 1);
    }

    // --- UI & EVENTS ---

    syncSettingsFromUI() {
        const getVal = (id) => parseFloat(document.getElementById(id).value);
        
        this.settings.coverage = getVal('in_coverage');
        this.settings.densityMult = getVal('in_densityMult');
        this.settings.baseScale = getVal('in_baseScale');
        this.settings.detailScale = getVal('in_detailScale');
        this.settings.detailWeight = getVal('in_detailWeight');
        this.settings.lightAbsorb = getVal('in_lightAbsorb');
        this.settings.scattering = getVal('in_scattering');
        this.settings.steps = parseInt(getVal('in_steps'));
        this.settings.windGlobal = getVal('in_windGlobal');
        this.state.resScale = getVal('in_resScale');

        const cloudHex = document.getElementById('in_cloudColor').value;
        const skyHex = document.getElementById('in_skyColor').value;
        this.settings.cloudColor = ColorUtils.hexToRgbLinear(cloudHex);
        this.settings.skyColor = ColorUtils.hexToRgbLinear(skyHex);
    }

    bindAllEvents() {
        this.bindUIEvents();
        this.bindCameraEvents();
        this.bindGimbalEvents();
        window.addEventListener('resize', () => this.resize());
    }

    bindUIEvents() {
        // Input Controls Listener
        document.querySelectorAll('input[type=range], input[type=color]').forEach(input => {
            input.addEventListener('input', (e) => {
                const id = e.target.id.split('_')[1];
                
                // Update numeric value display
                if (e.target.type === 'range') {
                    const valSpan = document.getElementById('val_' + id);
                    if (valSpan) valSpan.innerText = e.target.value;
                }
                
                // Update settings cache
                if (this.settings[id] !== undefined) {
                    if (e.target.type === 'color') {
                        this.settings[id] = ColorUtils.hexToRgbLinear(e.target.value);
                    } else {
                        this.settings[id] = parseFloat(e.target.value);
                    }
                }
                
                // Trigger resize if resolution scale changes
                if (id === 'resScale') { 
                    this.state.resScale = parseFloat(e.target.value); 
                    this.resize(); 
                }
            });
        });

        // Inspector Panel Toggle
        const toggleBtn = document.getElementById('toggle-panel');
        toggleBtn.addEventListener('click', () => {
            const appWrapper = document.getElementById('app-wrapper');
            appWrapper.classList.toggle('panel-hidden');
            
            toggleBtn.style.transform = appWrapper.classList.contains('panel-hidden') 
                ? "rotate(180deg)" 
                : "rotate(0deg)";
            
            // Wait for CSS transition before resizing the canvas
            setTimeout(() => this.resize(), 310);
        });

        // Simulation Pause/Play Button
        const btnPause = document.getElementById('btn_pause');
        btnPause.addEventListener('click', () => {
            this.state.isPaused = !this.state.isPaused;
            btnPause.innerText = this.state.isPaused ? "Play" : "Pause";
            btnPause.classList.toggle("paused", this.state.isPaused);
        });
    }

    bindCameraEvents() {
        let lastX = 0, lastY = 0;
        
        // Prevent default touch actions (scrolling/zooming) on the canvas
        this.canvas.style.touchAction = 'none';
        
        // Unified Pointer Events for Mouse, Touch, and Stylus
        this.canvas.addEventListener('pointerdown', (e) => { 
            this.state.isDragging = true; 
            lastX = e.clientX; 
            lastY = e.clientY; 
            this.canvas.setPointerCapture(e.pointerId);
        });
        
        this.canvas.addEventListener('pointerup', (e) => {
            this.state.isDragging = false;
            this.canvas.releasePointerCapture(e.pointerId);
        });
        
        this.canvas.addEventListener('pointermove', (e) => {
            if (this.state.isDragging) {
                this.cam.theta -= (e.clientX - lastX) * 0.01;
                this.cam.phi -= (e.clientY - lastY) * 0.01;
                // Clamp vertical rotation to prevent flipping
                this.cam.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, this.cam.phi)); 
                lastX = e.clientX; 
                lastY = e.clientY;
            }
        });

        this.canvas.addEventListener('wheel', (e) => {
            this.cam.radius += e.deltaY * 0.015;
            this.cam.radius = Math.max(4.0, Math.min(30.0, this.cam.radius));
        }, { passive: true });
    }

    bindGimbalEvents() {
        const gimbalCircle = document.getElementById('gimbal-circle');
        const dot = document.getElementById('gimbal-dot');
        
        gimbalCircle.style.touchAction = 'none';
        
        const updateSun = (e) => {
            const rect = gimbalCircle.getBoundingClientRect();
            let x = e.clientX - rect.left - rect.width / 2;
            let z = e.clientY - rect.top - rect.height / 2; 

            // Normalize coordinates to [-1, 1] range
            let nx = x / (rect.width / 2);
            let nz = z / (rect.height / 2);

            let distSq = nx * nx + nz * nz;
            if (distSq > 1.0) {
                let dist = Math.sqrt(distSq);
                nx /= dist; nz /= dist;
                distSq = 1.0;
            }

            // Update UI Dot position
            dot.style.left = `${(nx + 1.0) * 50}%`;
            dot.style.top = `${(nz + 1.0) * 50}%`;

            // Calculate Y component assuming a hemisphere (x^2 + y^2 + z^2 = 1)
            let ny = Math.sqrt(Math.max(0.0, 1.0 - distSq));
            
            // Prevent sun from going below the horizon completely to avoid lighting bugs
            this.sunDir = { x: nx, y: Math.max(0.05, ny), z: nz };
        };

        gimbalCircle.addEventListener('pointerdown', (e) => { 
            this.state.isDraggingGimbal = true; 
            gimbalCircle.setPointerCapture(e.pointerId);
            updateSun(e); 
        });
        
        gimbalCircle.addEventListener('pointermove', (e) => { 
            if (this.state.isDraggingGimbal) updateSun(e); 
        });
        
        gimbalCircle.addEventListener('pointerup', (e) => { 
            this.state.isDraggingGimbal = false;
            gimbalCircle.releasePointerCapture(e.pointerId);
        });
    }

    // --- RENDER PIPELINE ---

    resize() {
        const container = document.getElementById('viewport');
        this.canvas.width = container.clientWidth;
        this.canvas.height = container.clientHeight;
        
        const pixelRatio = window.devicePixelRatio || 1;
        const physicalWidth = this.canvas.width * pixelRatio;
        const physicalHeight = this.canvas.height * pixelRatio;
        
        const targetWidth = physicalWidth * this.state.resScale;
        const targetHeight = physicalHeight * this.state.resScale;
        
        // Resolution clamp to prevent GPU crashes on high-DPI displays
        const MAX_RES = 1920 * 1080;
        const currentRes = targetWidth * targetHeight;
        
        let scaleDown = 1.0;
        if (currentRes > MAX_RES) {
            scaleDown = Math.sqrt(MAX_RES / currentRes);
        }

        this.renderWidth = Math.max(1, Math.floor(targetWidth * scaleDown));
        this.renderHeight = Math.max(1, Math.floor(targetHeight * scaleDown));
        
        GLUtils.resizeFBO(this.gl, this.fboPing, this.renderWidth, this.renderHeight);
        GLUtils.resizeFBO(this.gl, this.fboPong, this.renderWidth, this.renderHeight);
        GLUtils.resizeFBO(this.gl, this.fboCurrent, this.renderWidth, this.renderHeight);
    }

    updateFPS(now) {
        this.state.fpsCounter++;
        if (now - this.state.lastFpsTime > 1000) {
            const fpsElem = document.getElementById('perf-stats');
            fpsElem.innerText = `FPS: ${this.state.fpsCounter} | Res: ${this.renderWidth}x${this.renderHeight}`;
            
            // Dynamic color coding for performance feedback
            fpsElem.style.color = this.state.fpsCounter > 45 ? '#4ade80' : 
                                  (this.state.fpsCounter > 25 ? '#facc15' : '#f87171');
            
            this.state.fpsCounter = 0; 
            this.state.lastFpsTime = now;
        }
    }

    drawQuad(prog) {
        const loc = this.gl.getAttribLocation(prog, "a_position");
        this.gl.enableVertexAttribArray(loc);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.posBuf);
        this.gl.vertexAttribPointer(loc, 2, this.gl.FLOAT, false, 0, 0);
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    renderShadowPass() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboShadow.fbo);
        gl.viewport(0, 0, 512, 512);
        gl.useProgram(this.progShadow);

        gl.activeTexture(gl.TEXTURE0); 
        gl.bindTexture(gl.TEXTURE_3D, this.noiseTex);
        gl.uniform1i(this.uShadow.noiseTex, 0);

        gl.activeTexture(gl.TEXTURE1); 
        gl.bindTexture(gl.TEXTURE_3D, this.detailTex);
        gl.uniform1i(this.uShadow.detailTex, 1);

        gl.uniform3f(this.uShadow.boxSize, 6.0, 3.0, 6.0); 
        gl.uniform3f(this.uShadow.sunDir, this.sunDir.x, this.sunDir.y, this.sunDir.z);
        gl.uniform1f(this.uShadow.baseScale, this.settings.baseScale);
        gl.uniform1f(this.uShadow.coverage, this.settings.coverage);
        gl.uniform1f(this.uShadow.densityMult, this.settings.densityMult);
        gl.uniform1f(this.uShadow.detailScale, this.settings.detailScale);
        gl.uniform1f(this.uShadow.detailWeight, this.settings.detailWeight);
        gl.uniform2f(this.uShadow.windOffset, this.wind.x, this.wind.z);

        this.drawQuad(this.progShadow);
    }

    renderCloudPass(cx, cy, cz, now) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboCurrent.fbo);
        gl.viewport(0, 0, this.renderWidth, this.renderHeight);
        gl.useProgram(this.progCloud);

        // Sub-pixel Jittering for TAA
        const phase = (this.state.globalFrame % 16) + 1;
        const jitterX = MathUtils.halton(phase, 2) - 0.5;
        const jitterY = MathUtils.halton(phase, 3) - 0.5;

        // Disable jitter during camera movement to prevent blurring
        const isMoving = this.state.isDragging || this.state.isDraggingGimbal;
        const finalJitterX = isMoving ? 0.0 : jitterX;
        const finalJitterY = isMoving ? 0.0 : jitterY;

        gl.uniform2f(this.uCloud.jitter, finalJitterX, finalJitterY);

        // Texture Bindings
        gl.activeTexture(gl.TEXTURE0); 
        gl.bindTexture(gl.TEXTURE_3D, this.noiseTex);
        gl.uniform1i(this.uCloud.noiseTex, 0);
        
        gl.activeTexture(gl.TEXTURE1); 
        gl.bindTexture(gl.TEXTURE_2D, this.fboShadow.tex);
        gl.uniform1i(this.uCloud.shadowTex, 1);

        gl.activeTexture(gl.TEXTURE2); 
        gl.bindTexture(gl.TEXTURE_3D, this.detailTex); 
        gl.uniform1i(this.uCloud.detailTex, 2); 

        gl.activeTexture(gl.TEXTURE3); 
        gl.bindTexture(gl.TEXTURE_2D, this.blueNoiseTex);
        gl.uniform1i(this.uCloud.blueNoiseTex, 3); 

        // Uniforms
        gl.uniform2f(this.uCloud.res, this.renderWidth, this.renderHeight);
        gl.uniform1f(this.uCloud.time, now * 0.001);
        gl.uniform1i(this.uCloud.frame, this.state.globalFrame); 
        gl.uniform3f(this.uCloud.camPos, cx, cy, cz);
        gl.uniform3f(this.uCloud.camTarget, 0, 0, 0);
        gl.uniform3f(this.uCloud.boxSize, 6.0, 3.0, 6.0); 
        
        gl.uniform1f(this.uCloud.baseScale, this.settings.baseScale);
        gl.uniform1f(this.uCloud.coverage, this.settings.coverage);
        gl.uniform1f(this.uCloud.densityMult, this.settings.densityMult);
        gl.uniform1f(this.uCloud.detailScale, this.settings.detailScale);
        gl.uniform1f(this.uCloud.detailWeight, this.settings.detailWeight);
        gl.uniform1f(this.uCloud.lightAbsorb, this.settings.lightAbsorb);
        gl.uniform1f(this.uCloud.scattering, this.settings.scattering);
        
        gl.uniform3f(this.uCloud.sunDir, this.sunDir.x, this.sunDir.y, this.sunDir.z);
        gl.uniform3f(this.uCloud.cloudColor, this.settings.cloudColor[0], this.settings.cloudColor[1], this.settings.cloudColor[2]);
        gl.uniform3f(this.uCloud.skyColor, this.settings.skyColor[0], this.settings.skyColor[1], this.settings.skyColor[2]);
        gl.uniform1i(this.uCloud.steps, this.settings.steps);
        gl.uniform2f(this.uCloud.windOffset, this.wind.x, this.wind.z);

        this.drawQuad(this.progCloud);
    }

    renderTAAPass(historyFBO, currentTarget) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, currentTarget.fbo); 
        gl.viewport(0, 0, this.renderWidth, this.renderHeight);
        gl.useProgram(this.progTAA);

        gl.activeTexture(gl.TEXTURE0); 
        gl.bindTexture(gl.TEXTURE_2D, this.fboCurrent.tex); 
        gl.uniform1i(this.uTAA.currentTex, 0);
        
        gl.activeTexture(gl.TEXTURE1); 
        gl.bindTexture(gl.TEXTURE_2D, historyFBO.tex); 
        gl.uniform1i(this.uTAA.historyTex, 1);

        // Dynamic blend factor: Discard history faster when moving
        const blendValue = (this.state.isDragging || this.state.isDraggingGimbal) ? 0.05 : 0.90;
        gl.uniform1f(this.uTAA.blendFactor, blendValue);

        this.drawQuad(this.progTAA);
    }

    renderDisplayPass(currentTarget) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); 
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.progDisplay);

        gl.activeTexture(gl.TEXTURE0); 
        gl.bindTexture(gl.TEXTURE_2D, currentTarget.tex); 
        gl.uniform1i(this.uDisplay.tex, 0);

        this.drawQuad(this.progDisplay);
    }

    render(now) {
        // Calculate delta time in seconds
        let dt = (now - this.state.lastTime) * 0.001; 
        this.state.lastTime = now;
        
        // Safeguard: Clamp dt to prevent massive jumps if tab is backgrounded
        if (dt > 0.1) dt = 0.016; 
        
        this.state.globalFrame++;
        this.updateFPS(now);

        // Update Physics
        if (!this.state.isPaused) {
            this.wind.x += this.settings.windGlobal * dt;
            this.wind.z += (this.settings.windGlobal * 0.5) * dt;
        }

        // Spherical to Cartesian Coordinates for Camera
        const cx = Math.cos(this.cam.theta) * Math.cos(this.cam.phi) * this.cam.radius;
        const cy = Math.sin(this.cam.phi) * this.cam.radius;
        const cz = Math.sin(this.cam.theta) * Math.cos(this.cam.phi) * this.cam.radius;

        // TAA Ping-Pong Topology
        const currentTarget = this.state.pingPong ? this.fboPing : this.fboPong;
        const historyFBO = this.state.pingPong ? this.fboPong : this.fboPing;

        // Execute Render Pipeline
        this.renderShadowPass();
        this.renderCloudPass(cx, cy, cz, now);
        this.renderTAAPass(historyFBO, currentTarget); 
        this.renderDisplayPass(currentTarget); 
        
        // Swap buffers for next frame
        this.state.pingPong = !this.state.pingPong;
        
        requestAnimationFrame((now) => this.render(now));
    }
}

// ============================================================================
// BOOTSTRAP
// ============================================================================
async function initApp() {
    const perfStats = document.getElementById('perf-stats');
    perfStats.innerText = "Loading shaders...";

    try {
        const [vsRes, fsCloudRes, fsTaaRes, fsShadowRes, fsDisplayRes] = await Promise.all([
            fetch('shaders/cloud.vert'), 
            fetch('shaders/cloud.frag'),
            fetch('shaders/taa.frag'), 
            fetch('shaders/shadow.frag'),
            fetch('shaders/display.frag')
        ]);
        
        if (!vsRes.ok || !fsCloudRes.ok || !fsTaaRes.ok || !fsShadowRes.ok || !fsDisplayRes.ok) {
            throw new Error("Error loading shaders.");
        }
        
        const vsText = await vsRes.text();
        const fsCloudText = await fsCloudRes.text();
        const fsTaaText = await fsTaaRes.text();
        const fsShadowText = await fsShadowRes.text();
        const fsDisplayText = await fsDisplayRes.text();

        const canvas = document.getElementById('glcanvas');
        const gl = GLUtils.init(canvas);
        
        const blueNoiseTex = GLUtils.loadTexture2D(gl, 'assets/bluenoise.png');
        
        const shaders = {
            cloud: GLUtils.createProgram(gl, vsText, fsCloudText),
            taa: GLUtils.createProgram(gl, vsText, fsTaaText),
            shadow: GLUtils.createProgram(gl, vsText, fsShadowText),
            display: GLUtils.createProgram(gl, vsText, fsDisplayText)
        };

        perfStats.innerText = "Baking 3D Volumen...";
        
        setTimeout(() => {
            const baseData = NoiseGenerator.generate3DTexture(64, 3.0, 4);
            const baseTex = GLUtils.create3DTexture(gl, 64, baseData);
            
            const detailData = NoiseGenerator.generate3DTexture(32, 6.0, 3);
            const detailTex = GLUtils.create3DTexture(gl, 32, detailData);
            
            perfStats.innerText = "Starting engine...";
            window.engine = new CloudEngine(canvas, gl, shaders, baseTex, detailTex, blueNoiseTex);
        }, 50);

    } catch (err) {
        perfStats.style.color = "#ef4444";
        perfStats.innerText = "Critical error: " + err.message;
        console.error(err);
    }
}

window.onload = initApp;