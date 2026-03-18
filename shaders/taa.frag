#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_currentTex;
uniform sampler2D u_historyTex;
uniform float u_blendFactor;

void main() {
    vec3 current = texture(u_currentTex, v_uv).rgb;
    vec3 history = texture(u_historyTex, v_uv).rgb;
    
    // Simple Exponential Moving Average (EMA) for Temporal Accumulation
    vec3 blended = mix(current, history, u_blendFactor);
    
    fragColor = vec4(blended, 1.0);
}