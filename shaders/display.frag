#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;

void main() {
    vec3 col = texture(u_tex, v_uv).rgb;

    // ACES Film Tonemapping Curve (SDR mapping)
    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
    
    // Gamma Correction (Linear to sRGB)
    col = pow(col, vec3(1.0 / 2.2));

    fragColor = vec4(col, 1.0);
}