/**
 * Utilities for managing WebGL2 context, Shaders, Textures, and Framebuffers.
 */
const GLUtils = {
    /**
     * Initializes the WebGL2 context and enables required extensions.
     * @param {HTMLCanvasElement} canvas
     * @returns {WebGL2RenderingContext}
     */
    init(canvas) {
        const gl = canvas.getContext('webgl2', { 
            antialias: false, 
            depth: false, 
            alpha: false,
            preserveDrawingBuffer: false 
        });
        
        if (!gl) {
            alert("Your browser does not support WebGL 2. It is required for 3D textures.");
            throw new Error("WebGL 2 not supported.");
        }

        // Required to render to Float32 textures (EXT_color_buffer_float)
        const extFloat = gl.getExtension("EXT_color_buffer_float"); 
        // Required to render to Float16 textures (RGBA16F) on many devices
        const extHalfFloat = gl.getExtension("EXT_color_buffer_half_float");

        if (!extFloat && !extHalfFloat) {
            console.warn("[GLUtils] Warning: Floating-point texture rendering might not be fully supported on this device.");
        }

        return gl;
    },

    /**
     * Compiles a single shader (Vertex or Fragment).
     */
    compileShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const shaderType = type === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment';
            console.error(`[GLUtils] Error compiling ${shaderType} Shader:\n`, gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    },

    /**
     * Links compiled shaders into a complete WebGL Program.
     */
    createProgram(gl, vsSource, fsSource) {
        const vertexShader = this.compileShader(gl, gl.VERTEX_SHADER, vsSource);
        const fragmentShader = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
        
        if (!vertexShader || !fragmentShader) return null;

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("[GLUtils] Error linking WebGL program:", gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return null;
        }
        
        // Clean up individual shaders once linked to the program
        gl.detachShader(program, vertexShader);
        gl.detachShader(program, fragmentShader);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        
        return program;
    },

    /**
     * Creates and uploads a 3D texture to the GPU.
     * @param {WebGL2RenderingContext} gl 
     * @param {number} size Cubic resolution (e.g., 64 for 64x64x64)
     * @param {Uint8Array} data Linear array with texture values
     */
    create3DTexture(gl, size, data) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, texture);
        
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);

        // 1-byte alignment (necessary when uploading 1-channel textures like R8)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
        
        // Reset alignment to default just in case
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        
        return texture;
    },

    /**
     * Creates a Framebuffer Object (FBO) with an attached texture.
     * Ideal for Render Passes (Shadow Mapping, TAA).
     */
    createFBO(gl, width, height, internalFormat = null, format = null, type = null) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        
        // Default values optimized for TAA and HDR (RGBA16F)
        const iFormat = internalFormat || gl.RGBA16F;
        const fmt = format || gl.RGBA;
        const t = type || gl.HALF_FLOAT;

        gl.texImage2D(gl.TEXTURE_2D, 0, iFormat, width, height, 0, fmt, t, null);
        
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error(`[GLUtils] Error creating FBO (Status: ${status}). Ensure float/half-float extensions are enabled.`);
        }
        
        // Unbind to prevent accidental modifications
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        return { fbo, tex, width, height, internalFormat: iFormat, format: fmt, type: t };
    },

    /**
     * Resizes an existing FBO efficiently without re-creating it.
     */
    resizeFBO(gl, fboObj, width, height) {
        if (!fboObj || (fboObj.width === width && fboObj.height === height)) return;
        
        gl.bindTexture(gl.TEXTURE_2D, fboObj.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, fboObj.internalFormat, width, height, 0, fboObj.format, fboObj.type, null);
        
        fboObj.width = width;
        fboObj.height = height;
    },

    /**
     * Loads a standard 2D texture (like Blue Noise) from a URL.
     */
    loadTexture2D(gl, url) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        
        // Temporary gray pixel while loading
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));

        const image = new Image();
        image.crossOrigin = "anonymous"; // Helps with CORS if loading from external CDN
        image.src = url;
        
        image.onload = () => {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            
            // Crucial for Blue Noise: REPEAT to cover the entire screen
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        };
        
        image.onerror = () => {
            console.error(`[GLUtils] Failed to load texture from URL: ${url}`);
        };
        
        return texture;
    }
};