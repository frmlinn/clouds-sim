// ============================================================================
// UTILITIES: COLOR & MATH
// ============================================================================
const ColorUtils = {
    // Converts sRGB color space to Linear color space (Crucial for physically based lighting)
    sRGBtoLinear: (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
    
    // Converts HTML Hex string (#RRGGBB) to normalized Linear RGB array [r, g, b]
    hexToRgbLinear: (hex) => {
        const bigint = parseInt(hex.substring(1), 16);
        return [
            ColorUtils.sRGBtoLinear(((bigint >> 16) & 255) / 255),
            ColorUtils.sRGBtoLinear(((bigint >> 8) & 255) / 255),
            ColorUtils.sRGBtoLinear((bigint & 255) / 255)
        ];
    },

    // Converts normalized RGB array [r, g, b] back to Hex string (for UI initialization)
    rgbLinearToHex: (rgb) => {
        const linearToSRGB = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        const to255 = (c) => Math.max(0, Math.min(255, Math.round(linearToSRGB(c) * 255)));
        return "#" + (1 << 24 | to255(rgb[0]) << 16 | to255(rgb[1]) << 8 | to255(rgb[2])).toString(16).slice(1);
    }
};

const MathUtils = {
    // Halton sequence generator for low-discrepancy sub-pixel jittering (TAA)
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
// CORE GRAPHICS ENGINE
// ============================================================================
class CloudEngine {
    constructor(canvas, gl, shaders, textures) {
        this.canvas = canvas;
        this.gl = gl;
        
        // Resources
        this.texBaseNoise = textures.baseNoise;
        this.texDetailNoise = textures.detailNoise;
        this.texBlueNoise = textures.blueNoise;
        
        // Shader Programs
        this.progCloud = shaders.cloud;
        this.progTAA = shaders.taa;
        this.progShadow = shaders.shadow;
        this.progDisplay = shaders.display;
        
        // --- Single Source of Truth (SSOT) State ---
        
        // Camera (Spherical coords) & Environment
        this.cam = { theta: 0.5, phi: 0.8, radius: 14.0 };
        this.sunDir = { x: 0.0, y: 1.0, z: 0.0 };
        this.wind = { x: 0, z: 0 };
        
        // Material & Simulation Parameters
        this.settings = {
            coverage: 0.55,
            densityMult: 11.0,
            baseScale: 1.8,
            detailScale: 5.0,
            detailWeight: 0.3,
            lightAbsorb: 1.3,
            scattering: 0.95,
            steps: 40,
            windGlobal: 0.3,
            resScale: 0.5,
            skyColor: ColorUtils.hexToRgbLinear("#1e293b"),
            cloudColor: [1.0, 1.0, 1.0]
        };

        // Internal Engine State
        this.state = {
            isPaused: false,
            isDragging: false,
            isDraggingGimbal: false,
            pingPong: true, // TAA buffer toggle
            globalFrame: 0,
            lastTime: performance.now(),
            fpsCounter: 0,
            lastFpsTime: performance.now()
        };

        // Bootstrap Pipeline
        this.initGeometry();
        this.initUniformLocations();
        this.initFBOs();
        
        // Inject SSOT into DOM and bind event listeners
        this.initUIState();
        this.bindEvents();
        
        this.resize();
        
        // Start Render Loop
        requestAnimationFrame((now) => this.renderLoop(now));
    }

    // ========================================================================
    // INITIALIZATION & SETUP
    // ========================================================================

    initGeometry() {
        // Shared Fullscreen Quad for all post-processing passes
        this.quadVBO = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quadVBO);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,   1, -1,  -1,  1,
            -1,  1,   1, -1,   1,  1
        ]), this.gl.STATIC_DRAW);
    }

    initUniformLocations() {
        const getLoc = (prog, name) => this.gl.getUniformLocation(prog, name);

        this.uniforms = {
            cloud: {
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
            },
            shadow: {
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
            },
            taa: {
                currentTex: getLoc(this.progTAA, "u_currentTex"),
                historyTex: getLoc(this.progTAA, "u_historyTex"),
                blendFactor: getLoc(this.progTAA, "u_blendFactor")
            },
            display: {
                screenTex: getLoc(this.progDisplay, "u_screenTex")
            }
        };
    }

    initFBOs() {
        // Temporal Anti-Aliasing (Ping-Pong buffers)
        this.fboPing = GLUtils.createFBO(this.gl, 1, 1);
        this.fboPong = GLUtils.createFBO(this.gl, 1, 1);
        
        // Volumetric Shadow Map: Orthographic depth accumulation (R16F for high precision, single channel)
        this.fboShadow = GLUtils.createFBO(this.gl, 512, 512, this.gl.R16F, this.gl.RED, this.gl.HALF_FLOAT); 
        
        // Main Raymarching output target
        this.fboCurrent = GLUtils.createFBO(this.gl, 1, 1);
    }

    // ========================================================================
    // UI & STATE MANAGEMENT
    // ========================================================================

    initUIState() {
        // Push internal JS state into the HTML DOM (Single Source of Truth)
        const updateDomInput = (id, value, isColor = false) => {
            const input = document.getElementById(id);
            if (!input) return;
            
            if (isColor) {
                input.value = ColorUtils.rgbLinearToHex(value);
            } else {
                input.value = value;
                const display = document.getElementById(id.replace('in_', 'val_'));
                if (display) display.innerText = value;
            }
        };

        updateDomInput('in_coverage', this.settings.coverage);
        updateDomInput('in_densityMult', this.settings.densityMult);
        updateDomInput('in_baseScale', this.settings.baseScale);
        updateDomInput('in_detailScale', this.settings.detailScale);
        updateDomInput('in_detailWeight', this.settings.detailWeight);
        updateDomInput('in_lightAbsorb', this.settings.lightAbsorb);
        updateDomInput('in_scattering', this.settings.scattering);
        updateDomInput('in_steps', this.settings.steps);
        updateDomInput('in_windGlobal', this.settings.windGlobal);
        updateDomInput('in_resScale', this.settings.resScale);
        
        updateDomInput('in_cloudColor', this.settings.cloudColor, true);
        updateDomInput('in_skyColor', this.settings.skyColor, true);
    }

    bindEvents() {
        this.bindPanelEvents();
        this.bindViewportEvents();
        this.bindGimbalEvents();
        window.addEventListener('resize', () => this.resize());
    }

    bindPanelEvents() {
        // Universal listener for all properties
        document.querySelectorAll('input[type=range], input[type=color]').forEach(input => {
            input.addEventListener('input', (e) => {
                const key = e.target.id.split('_')[1]; // e.g., 'in_coverage' -> 'coverage'
                
                if (e.target.type === 'range') {
                    const val = parseFloat(e.target.value);
                    this.settings[key] = val;
                    document.getElementById('val_' + key).innerText = val;
                    
                    if (key === 'resScale') this.resize();
                } else if (e.target.type === 'color') {
                    this.settings[key] = ColorUtils.hexToRgbLinear(e.target.value);
                }
            });
        });

        // Toggle UI Sidebar
        const toggleBtn = document.getElementById('toggle-panel');
        toggleBtn.addEventListener('click', () => {
            const wrapper = document.getElementById('app-wrapper');
            wrapper.classList.toggle('panel-hidden');
            toggleBtn.style.transform = wrapper.classList.contains('panel-hidden') ? "rotate(180deg)" : "rotate(0deg)";
            setTimeout(() => this.resize(), 310); // Wait for CSS transition
        });

        // Pause/Play Time
        const btnPause = document.getElementById('btn_pause');
        btnPause.addEventListener('click', () => {
            this.state.isPaused = !this.state.isPaused;
            btnPause.innerText = this.state.isPaused ? "Play" : "Pause";
            btnPause.classList.toggle("paused", this.state.isPaused);
        });
    }

    bindViewportEvents() {
        let lastX = 0, lastY = 0;
        this.canvas.style.touchAction = 'none';
        
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
            if (!this.state.isDragging) return;
            this.cam.theta -= (e.clientX - lastX) * 0.01;
            this.cam.phi -= (e.clientY - lastY) * 0.01;
            // Constrain vertical orbit to prevent Gimbal lock / going below ground
            this.cam.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, this.cam.phi)); 
            lastX = e.clientX; 
            lastY = e.clientY;
        });

        this.canvas.addEventListener('wheel', (e) => {
            this.cam.radius += e.deltaY * 0.015;
            this.cam.radius = Math.max(4.0, Math.min(40.0, this.cam.radius));
        }, { passive: true });
    }

    bindGimbalEvents() {
        const circle = document.getElementById('gimbal-circle');
        const dot = document.getElementById('gimbal-dot');
        circle.style.touchAction = 'none';
        
        const updateSunVector = (e) => {
            const rect = circle.getBoundingClientRect();
            // Map pixel space to normalized [-1, 1] Cartesian space
            let nx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
            let nz = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);

            let distSq = nx * nx + nz * nz;
            if (distSq > 1.0) {
                const dist = Math.sqrt(distSq);
                nx /= dist; nz /= dist;
                distSq = 1.0;
            }

            // Map visual dot representation
            dot.style.left = `${(nx + 1.0) * 50}%`;
            dot.style.top = `${(nz + 1.0) * 50}%`;

            // Derive Y height (hemisphere projection: y = sqrt(1 - x^2 - z^2))
            let ny = Math.sqrt(Math.max(0.0, 1.0 - distSq));
            
            // Clamp Y to prevent sun illuminating clouds from below the horizon
            this.sunDir = { x: nx, y: Math.max(0.05, ny), z: nz };
        };

        circle.addEventListener('pointerdown', (e) => { 
            this.state.isDraggingGimbal = true; 
            circle.setPointerCapture(e.pointerId);
            updateSunVector(e); 
        });
        circle.addEventListener('pointermove', (e) => { 
            if (this.state.isDraggingGimbal) updateSunVector(e); 
        });
        circle.addEventListener('pointerup', (e) => { 
            this.state.isDraggingGimbal = false;
            circle.releasePointerCapture(e.pointerId);
        });
    }

    // ========================================================================
    // RENDER PIPELINE
    // ========================================================================

    resize() {
        const container = document.getElementById('viewport');
        this.canvas.width = container.clientWidth;
        this.canvas.height = container.clientHeight;
        
        const dpr = window.devicePixelRatio || 1;
        const targetW = this.canvas.width * dpr * this.settings.resScale;
        const targetH = this.canvas.height * dpr * this.settings.resScale;
        
        // Anti-crash safeguard for ultra-wide/high-DPI monitors
        const MAX_PIXELS = 1920 * 1080;
        const scaleDown = (targetW * targetH > MAX_PIXELS) ? Math.sqrt(MAX_PIXELS / (targetW * targetH)) : 1.0;

        this.renderW = Math.max(1, Math.floor(targetW * scaleDown));
        this.renderH = Math.max(1, Math.floor(targetH * scaleDown));
        
        GLUtils.resizeFBO(this.gl, this.fboPing, this.renderW, this.renderH);
        GLUtils.resizeFBO(this.gl, this.fboPong, this.renderW, this.renderH);
        GLUtils.resizeFBO(this.gl, this.fboCurrent, this.renderW, this.renderH);
    }

    _drawQuad(prog) {
        const loc = this.gl.getAttribLocation(prog, "a_position");
        this.gl.enableVertexAttribArray(loc);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quadVBO);
        this.gl.vertexAttribPointer(loc, 2, this.gl.FLOAT, false, 0, 0);
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    passShadowMap() {
        const gl = this.gl;
        const u = this.uniforms.shadow;
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboShadow.fbo);
        gl.viewport(0, 0, 512, 512); // Fixed shadow map resolution
        gl.useProgram(this.progShadow);

        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, this.texBaseNoise);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.texDetailNoise);
        gl.uniform1i(u.noiseTex, 0);
        gl.uniform1i(u.detailTex, 1);

        gl.uniform3f(u.boxSize, 6.0, 3.0, 6.0); 
        gl.uniform3f(u.sunDir, this.sunDir.x, this.sunDir.y, this.sunDir.z);
        gl.uniform1f(u.baseScale, this.settings.baseScale);
        gl.uniform1f(u.coverage, this.settings.coverage);
        gl.uniform1f(u.densityMult, this.settings.densityMult);
        gl.uniform1f(u.detailScale, this.settings.detailScale);
        gl.uniform1f(u.detailWeight, this.settings.detailWeight);
        gl.uniform2f(u.windOffset, this.wind.x, this.wind.z);

        this._drawQuad(this.progShadow);
    }

    passRaymarching(cx, cy, cz, timeSecs) {
        const gl = this.gl;
        const u = this.uniforms.cloud;
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboCurrent.fbo);
        gl.viewport(0, 0, this.renderW, this.renderH);
        gl.useProgram(this.progCloud);

        // TAA Sub-pixel Jitter (Disabled during camera movement to prevent smearing)
        const isMoving = this.state.isDragging || this.state.isDraggingGimbal;
        const phase = (this.state.globalFrame % 16) + 1;
        const jX = isMoving ? 0.0 : MathUtils.halton(phase, 2) - 0.5;
        const jY = isMoving ? 0.0 : MathUtils.halton(phase, 3) - 0.5;
        gl.uniform2f(u.jitter, jX, jY);

        // Bind Textures
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, this.texBaseNoise);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.fboShadow.tex);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, this.texDetailNoise);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.texBlueNoise);
        
        gl.uniform1i(u.noiseTex, 0);
        gl.uniform1i(u.shadowTex, 1);
        gl.uniform1i(u.detailTex, 2); 
        gl.uniform1i(u.blueNoiseTex, 3); 

        // Bind Uniforms
        gl.uniform2f(u.res, this.renderW, this.renderH);
        gl.uniform1f(u.time, timeSecs);
        gl.uniform1i(u.frame, this.state.globalFrame); 
        gl.uniform3f(u.camPos, cx, cy, cz);
        gl.uniform3f(u.camTarget, 0, 0, 0);
        gl.uniform3f(u.boxSize, 6.0, 3.0, 6.0); 
        
        gl.uniform1f(u.baseScale, this.settings.baseScale);
        gl.uniform1f(u.coverage, this.settings.coverage);
        gl.uniform1f(u.densityMult, this.settings.densityMult);
        gl.uniform1f(u.detailScale, this.settings.detailScale);
        gl.uniform1f(u.detailWeight, this.settings.detailWeight);
        gl.uniform1f(u.lightAbsorb, this.settings.lightAbsorb);
        gl.uniform1f(u.scattering, this.settings.scattering);
        
        gl.uniform3f(u.sunDir, this.sunDir.x, this.sunDir.y, this.sunDir.z);
        gl.uniform3fv(u.cloudColor, this.settings.cloudColor);
        gl.uniform3fv(u.skyColor, this.settings.skyColor);
        gl.uniform1i(u.steps, this.settings.steps);
        gl.uniform2f(u.windOffset, this.wind.x, this.wind.z);

        this._drawQuad(this.progCloud);
    }

    passTAA(historyFBO, targetFBO) {
        const gl = this.gl;
        const u = this.uniforms.taa;
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO.fbo); 
        gl.viewport(0, 0, this.renderW, this.renderH);
        gl.useProgram(this.progTAA);

        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fboCurrent.tex); 
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, historyFBO.tex); 
        gl.uniform1i(u.currentTex, 0);
        gl.uniform1i(u.historyTex, 1);

        // Responsive TAA: Reject history faster if camera or light is moving
        const blendValue = (this.state.isDragging || this.state.isDraggingGimbal) ? 0.05 : 0.90;
        gl.uniform1f(u.blendFactor, blendValue);

        this._drawQuad(this.progTAA);
    }

    passDisplay(sourceFBO) {
        const gl = this.gl;
        const u = this.uniforms.display;
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Render to Canvas
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.progDisplay);

        gl.activeTexture(gl.TEXTURE0); 
        gl.bindTexture(gl.TEXTURE_2D, sourceFBO.tex); 
        gl.uniform1i(u.screenTex, 0);

        this._drawQuad(this.progDisplay);
    }

    renderLoop(now) {
        // Delta time handling
        let dt = (now - this.state.lastTime) * 0.001; 
        this.state.lastTime = now;
        if (dt > 0.1) dt = 0.016; // Prevent massive jumps after tab focus recovery
        
        // Stats & State Update
        this.state.globalFrame++;
        this.state.fpsCounter++;
        
        if (now - this.state.lastFpsTime > 1000) {
            const fpsEl = document.getElementById('perf-stats');
            fpsEl.innerText = `FPS: ${this.state.fpsCounter} | Target Res: ${this.renderW}x${this.renderH}`;
            fpsEl.style.color = this.state.fpsCounter > 45 ? '#4ade80' : (this.state.fpsCounter > 25 ? '#facc15' : '#f87171');
            this.state.fpsCounter = 0; 
            this.state.lastFpsTime = now;
        }

        // Physics step
        if (!this.state.isPaused) {
            this.wind.x += this.settings.windGlobal * dt;
            this.wind.z += (this.settings.windGlobal * 0.5) * dt; // Slight drift
        }

        // Camera Math
        const cx = Math.cos(this.cam.theta) * Math.cos(this.cam.phi) * this.cam.radius;
        const cy = Math.sin(this.cam.phi) * this.cam.radius;
        const cz = Math.sin(this.cam.theta) * Math.cos(this.cam.phi) * this.cam.radius;

        // TAA Buffer Management
        const fboTarget = this.state.pingPong ? this.fboPing : this.fboPong;
        const fboHistory = this.state.pingPong ? this.fboPong : this.fboPing;

        // Dispatch Render Passes
        this.passShadowMap();
        this.passRaymarching(cx, cy, cz, now * 0.001);
        this.passTAA(fboHistory, fboTarget); 
        this.passDisplay(fboTarget); 
        
        // Cycle buffer topology
        this.state.pingPong = !this.state.pingPong;
        
        requestAnimationFrame((now) => this.renderLoop(now));
    }
}

// ============================================================================
// BOOTSTRAP & ASSET LOADING
// ============================================================================
async function initApp() {
    const stats = document.getElementById('perf-stats');
    stats.innerText = "Loading shaders...";

    try {
        // Fetch all shader sources concurrently
        const urls = ['cloud.vert', 'cloud.frag', 'taa.frag', 'shadow.frag', 'display.frag'];
        const responses = await Promise.all(urls.map(file => fetch(`shaders/${file}`)));
        
        if (responses.some(r => !r.ok)) throw new Error("Failed to load one or more shaders.");
        
        const [vs, fsCloud, fsTAA, fsShadow, fsDisplay] = await Promise.all(responses.map(r => r.text()));

        const canvas = document.getElementById('glcanvas');
        const gl = GLUtils.init(canvas);
        
        // Compile Shader Programs
        const shaders = {
            cloud: GLUtils.createProgram(gl, vs, fsCloud),
            taa: GLUtils.createProgram(gl, vs, fsTAA),
            shadow: GLUtils.createProgram(gl, vs, fsShadow),
            display: GLUtils.createProgram(gl, vs, fsDisplay)
        };

        // Load Dithering Texture
        const blueNoiseTex = GLUtils.loadTexture2D(gl, 'assets/bluenoise.png');
        
        stats.innerText = "Baking 3D Volume (CPU)...";
        
        // Allow UI to update before blocking the main thread with noise generation
        setTimeout(() => {
            // Generate Tileable 3D Worley Noise
            const baseData = NoiseGenerator.generate3DTexture(64, 3.0, 4);
            const detailData = NoiseGenerator.generate3DTexture(32, 6.0, 3);
            
            const textures = {
                baseNoise: GLUtils.create3DTexture(gl, 64, baseData),
                detailNoise: GLUtils.create3DTexture(gl, 32, detailData),
                blueNoise: blueNoiseTex
            };
            
            stats.innerText = "Starting engine...";
            window.engine = new CloudEngine(canvas, gl, shaders, textures);
            
        }, 50);

    } catch (err) {
        stats.style.color = "#ef4444";
        stats.innerText = "Critical Error: " + err.message;
        console.error(err);
    }
}

window.addEventListener('load', initApp);