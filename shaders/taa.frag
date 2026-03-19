#version 300 es
precision highp float; // Highp is critical here to prevent floating point drift across frames

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_currentTex; // Jittered current frame
uniform sampler2D u_historyTex; // Accumulated history frame
uniform float u_blendFactor;    // ~0.05 - 0.1 for temporal responsiveness

void main() {
    vec3 current = texture(u_currentTex, v_uv).rgb;
    vec3 history = texture(u_historyTex, v_uv).rgb;
    
    // Exponential Moving Average (EMA)
    vec3 blended = mix(current, history, u_blendFactor);
    
    fragColor = vec4(blended, 1.0);
}