export const SHADER_CODE: string = `
#version 300 es

out vec2 v_texCoord;
out vec3 v_barycentric;

const float width = 512.0;
const float height = 334.0;
const vec2 dimensions = vec2(width, height);

const vec2 vertices[3] = vec2[3](
    vec2(20, 200),
    vec2(400, 200),
    vec2(200, 20)
);

const vec3 barycentric[3] = vec3[3](
    vec3(1, 0, 0),
    vec3(0, 1, 0),
    vec3(0, 0, 1)
);

void main() {
    vec2 screenPos = vertices[gl_VertexID];
    screenPos.y = height - screenPos.y - 1.0;
    gl_Position = vec4(screenPos / dimensions * 2.0 - 1.0, 0.0, 1.0);
    v_texCoord = gl_Position.xy * 0.5 + 0.5;
    v_barycentric = barycentric[gl_VertexID];
}
`.trim();
