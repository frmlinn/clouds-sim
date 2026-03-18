#version 300 es

in vec4 a_position;
out vec2 v_uv;

void main() {
    gl_Position = a_position;
    // Map NDC (-1.0 to 1.0) to UV space (0.0 to 1.0)
    v_uv = a_position.xy * 0.5 + 0.5;
}