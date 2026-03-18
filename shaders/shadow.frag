#version 300 es
precision mediump float;
precision mediump sampler3D;

in vec2 v_uv;
out vec4 fragColor;

// ============================================================================
// UNIFORMS
// ============================================================================
uniform vec3 u_boxSize;
uniform vec3 u_sunDir;
uniform sampler3D u_noiseTex;
uniform sampler3D u_detailTex;

uniform float u_baseScale;
uniform float u_coverage;
uniform float u_densityMult;
uniform float u_detailScale;
uniform float u_detailWeight;
uniform vec2 u_windOffset;

const int SHADOW_STEPS = 25;

// ============================================================================
// UTILS & DENSITY
// ============================================================================
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

float remap(float val, float oldMin, float oldMax, float newMin, float newMax) {
    return newMin + (val - oldMin) * (newMax - newMin) / (oldMax - oldMin);
}

// NOTE: Density function must remain identical to the one in cloud.frag
float getDensity(vec3 p) {
    float heightPercent = (p.y + u_boxSize.y) / (2.0 * u_boxSize.y);
    float heightGradient = smoothstep(0.0, 0.15, heightPercent) * smoothstep(1.0, 0.4, heightPercent);
    vec3 distToEdge = u_boxSize - abs(p);
    float edgeFade = smoothstep(0.0, 1.5, min(min(distToEdge.x, distToEdge.y), distToEdge.z));
    float mask = heightGradient * edgeFade;
    
    if (mask <= 0.0) return 0.0; 
    
    vec3 pos = p + vec3(u_windOffset.x, 0.0, u_windOffset.y);
    
    // textureLod enforces explicit MIP level, resolving gradient issues in loops
    float baseNoise = textureLod(u_noiseTex, pos * u_baseScale * 0.1, 0.0).r;
    float baseDensity = remap(baseNoise, 1.0 - u_coverage, 1.0, 0.0, 1.0);
    
    baseDensity *= mask; 
    if (baseDensity <= 0.0) return 0.0;
    
    if (u_detailWeight > 0.0) {
        float detailNoise = textureLod(u_detailTex, pos * u_detailScale * 0.1, 0.0).r;
        float erosion = detailNoise * u_detailWeight;
        baseDensity = baseDensity - erosion * (1.0 - baseDensity);
    }
    
    return max(0.0, baseDensity) * u_densityMult;
}

// ============================================================================
// MAIN (Orthographic Shadow Pass)
// ============================================================================
void main() {
    vec3 sunDir = normalize(u_sunDir);
    vec3 sunRight, sunUp;
    getSunBasis(sunDir, sunRight, sunUp);

    float orthoSize = length(u_boxSize);
    
    // Map NDC [0, 1] to [-0.5, 0.5] for centered projection
    vec2 uv = v_uv - 0.5;

    // Cast orthographic ray from the sun plane towards the volume
    vec3 ro = sunRight * (uv.x * orthoSize * 2.0) + sunUp * (uv.y * orthoSize * 2.0) + sunDir * orthoSize;
    vec3 rd = -sunDir; 

    vec2 hitInfo = intersectAABB(-u_boxSize, u_boxSize, ro, rd);
    float totalDensity = 0.0;

    if (hitInfo.y > 0.0) {
        float stepSize = hitInfo.y / float(SHADOW_STEPS);
        // Start half a step forward to avoid planar artifacts
        vec3 p = ro + rd * (hitInfo.x + stepSize * 0.5);
        
        for(int i = 0; i < SHADOW_STEPS; i++) {
            totalDensity += getDensity(p) * stepSize;
            p += rd * stepSize;
        }
    }
    
    // Store accumulated density in the Red channel (R16F mapping)
    fragColor = vec4(totalDensity, 0.0, 0.0, 1.0);
}