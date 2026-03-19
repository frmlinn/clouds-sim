#version 300 es
precision mediump float;
precision mediump sampler3D;

in vec2 v_uv;
out vec4 fragColor;

// ============================================================================
// UNIFORMS: SYSTEM & CAMERA
// ============================================================================
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_frame;
uniform vec3 u_camPos;
uniform vec3 u_camTarget;

// ============================================================================
// UNIFORMS: VOLUME & SHAPE
// ============================================================================
uniform vec3 u_boxSize;
uniform float u_baseScale;
uniform float u_coverage;
uniform float u_densityMult;
uniform float u_detailScale;
uniform float u_detailWeight;
uniform vec2 u_windOffset;

// ============================================================================
// UNIFORMS: OPTICS & LIGHTING
// ============================================================================
uniform float u_lightAbsorb;
uniform float u_scattering;
uniform vec3 u_sunDir;
uniform vec3 u_cloudColor;
uniform vec3 u_skyColor;
uniform int u_steps;

// ============================================================================
// UNIFORMS: TEXTURES
// ============================================================================
uniform sampler3D u_noiseTex;
uniform sampler3D u_detailTex;
uniform sampler2D u_shadowTex;
uniform sampler2D u_blueNoiseTex;
uniform vec2 u_jitter; // TAA Sub-pixel offset

const float PI = 3.14159265359;

// ============================================================================
// UTILITIES (Shared with shadow.frag)
// ============================================================================
float remap(float val, float oldMin, float oldMax, float newMin, float newMax) {
    return newMin + (val - oldMin) * (newMax - newMin) / (oldMax - oldMin);
}

vec2 intersectAABB(vec3 boundsMin, vec3 boundsMax, vec3 ro, vec3 rd) {
    vec3 t0 = (boundsMin - ro) / rd;
    vec3 t1 = (boundsMax - ro) / rd;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    
    float dstA = max(max(tmin.x, tmin.y), tmin.z);
    float dstB = min(tmax.x, min(tmax.y, tmax.z));
    
    return vec2(max(0.0, dstA), max(0.0, dstB - max(0.0, dstA)));
}

void getSunBasis(vec3 sunDir, out vec3 sunRight, out vec3 sunUp) {
    vec3 up = abs(sunDir.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    sunRight = normalize(cross(up, sunDir));
    sunUp = normalize(cross(sunDir, sunRight));
}

// ============================================================================
// RENDERING SPECIFICS
// ============================================================================
float getDither() {
    vec2 noiseUV = gl_FragCoord.xy / 256.0; 
    float blueNoise = texture(u_blueNoiseTex, noiseUV).r;
    // Golden ratio offset for optimal TAA distribution over frames
    return fract(blueNoise + float(u_frame % 64) * 0.61803398875);
}

mat3 setCamera(in vec3 ro, in vec3 ta, float cr) {
    vec3 cw = normalize(ta - ro);
    vec3 cp = vec3(sin(cr), cos(cr), 0.0);
    vec3 cu = normalize(cross(cw, cp));
    vec3 cv = cross(cu, cw);
    return mat3(cu, cv, cw);
}

float hg(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

float dualLobehg(float cosTheta, float g) {
    float forward = hg(cosTheta, max(g, 0.7)); 
    float backward = hg(cosTheta, -0.2); 
    return mix(forward, backward, 0.3);
}

// ============================================================================
// DENSITY SAMPLING (Must perfectly match shadow.frag)
// ============================================================================
float getDensity(vec3 p) {
    float heightPercent = (p.y + u_boxSize.y) / (2.0 * u_boxSize.y);
    float heightGradient = smoothstep(0.0, 0.15, heightPercent) * smoothstep(1.0, 0.4, heightPercent);
    
    vec3 distToEdge = u_boxSize - abs(p);
    float edgeFade = smoothstep(0.0, 1.5, min(min(distToEdge.x, distToEdge.y), distToEdge.z));
    
    float mask = heightGradient * edgeFade;
    if (mask <= 0.0) return 0.0; 
    
    vec3 pos = p + vec3(u_windOffset.x, 0.0, u_windOffset.y);
    
    // Lod 0 strictly required inside loops to prevent derivative divergence
    float baseNoise = textureLod(u_noiseTex, pos * u_baseScale * 0.1, 0.0).r;
    float baseDensity = remap(baseNoise, 1.0 - u_coverage, 1.0, 0.0, 1.0);
    baseDensity *= mask; 
    
    if (baseDensity <= 0.0) return 0.0;
    
    if (u_detailWeight > 0.0) {
        float detailNoise = textureLod(u_detailTex, pos * u_detailScale * 0.1, 0.0).r;
        float erosion = detailNoise * u_detailWeight;
        baseDensity = baseDensity - erosion * (1.0 - baseDensity); // Pre-multiplied subtraction
    }
    
    return max(0.0, baseDensity) * u_densityMult;
}

// Evaluates lighting at current step using the pre-baked shadow map
float lightMarch(vec3 p, vec3 sunRight, vec3 sunUp, float orthoSize, vec3 sunDir) {
    vec2 shadowUV = vec2(
        dot(p, sunRight) / (orthoSize * 2.0) + 0.5,
        dot(p, sunUp) / (orthoSize * 2.0) + 0.5
    );

    float totalDensity = textureLod(u_shadowTex, shadowUV, 0.0).r;
    float distAlongSun = dot(p, sunDir);
    float depthFraction = clamp((distAlongSun / orthoSize) * 0.5 + 0.5, 0.0, 1.0);
    
    float densityToSun = totalDensity * (1.0 - depthFraction);
    return exp(-densityToSun * u_lightAbsorb);
}

// ============================================================================
// MAIN INTEGRATION LOOP
// ============================================================================
void main() {
    vec2 fragCoordJittered = gl_FragCoord.xy + u_jitter;
    vec2 uv = (fragCoordJittered - 0.5 * u_resolution.xy) / u_resolution.y;
    
    mat3 camMat = setCamera(u_camPos, u_camTarget, 0.0);
    vec3 rd = normalize(camMat * vec3(uv, 1.2)); 
    vec3 sunDir = normalize(u_sunDir);
    
    vec3 sunRight, sunUp;
    getSunBasis(sunDir, sunRight, sunUp);
    float orthoSize = length(u_boxSize);
    
    // Background rendering
    vec3 bgCol = u_skyColor;
    float skySunDot = max(0.0, dot(rd, sunDir));
    bgCol += vec3(1.0, 0.9, 0.7) * pow(skySunDot, 800.0) * 2.0; 

    if (rd.y < 0.0) {
        float tGround = (-u_boxSize.y - 1.0 - u_camPos.y) / rd.y;
        if (tGround > 0.0) {
            vec3 pGround = u_camPos + rd * tGround;
            float grid = smoothstep(0.4, 0.5, fract(pGround.x)) * smoothstep(0.4, 0.5, fract(pGround.z));
            bgCol = mix(bgCol, bgCol * 0.5, grid * 0.15);
        }
    }

    vec3 finalColor = bgCol;
    vec2 hitInfo = intersectAABB(-u_boxSize, u_boxSize, u_camPos, rd);
    
    if (hitInfo.y > 0.0) {
        float baseStepSize = hitInfo.y / float(u_steps);
        float currentStepSize = baseStepSize;
        
        float cosTheta = dot(rd, sunDir); 
        float phaseVal = mix(dualLobehg(cosTheta, u_scattering), 1.0, 0.3);
        
        float transmittance = 1.0; 
        vec3 lightEnergy = vec3(0.0);
        float t = currentStepSize * getDither(); // Jitter start position
        
        for(int i = 0; i < 150; i++) {
            if(i >= u_steps || t >= hitInfo.y || transmittance < 0.01) break;
            
            vec3 p = u_camPos + rd * (hitInfo.x + t);
            float density = getDensity(p);
            
            if (density > 0.0) {
                float lightTransmittance = lightMarch(p, sunRight, sunUp, orthoSize, sunDir);
                float powder = 1.0 - exp(-density * 2.0); // Silver-lining effect
                
                vec3 ambientLight = u_cloudColor * 0.25; 
                vec3 directionalLight = u_cloudColor * lightTransmittance * powder * phaseVal;
                
                float stepTransmittance = exp(-density * currentStepSize * u_lightAbsorb);
                
                lightEnergy += density * currentStepSize * transmittance * (ambientLight + directionalLight);
                transmittance *= stepTransmittance;
                t += currentStepSize;
            } else {
                t += currentStepSize * 2.0; // Space skipping optimization
            }
        }
        
        finalColor = bgCol * transmittance + lightEnergy;
    }
    
    fragColor = vec4(finalColor, 1.0);
}