import {UNPACK_COLOR888} from './shader-commons.wgsl';

export const SHADER_CODE: string = `
struct PixelBuffer {
  data: array<i32>,
};

struct Uniforms {
  screenWidth: f32,
  screenHeight: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> pixelBuffer: PixelBuffer;

struct VertexOutput {
  @builtin(position) Position: vec4f,
  @location(0) TexCoord: vec2f,
};

${UNPACK_COLOR888}

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
  var pos = array(
    vec2f(-1,  3),
    vec2f( 3, -1),
    vec2f(-1, -1),
  );

  var output: VertexOutput;
  output.Position = vec4f(pos[VertexIndex], 0.0, 1.0);
  output.TexCoord = pos[VertexIndex] * 0.5 + 0.5;
  output.TexCoord.y = 1.0 - output.TexCoord.y;
  return output;
}

@fragment
fn frag_main(@location(0) TexCoord: vec2f) -> @location(0) vec4f {
  let coord = floor(vec2f(TexCoord.x * uniforms.screenWidth, TexCoord.y * uniforms.screenHeight));
  let index = u32(coord.y * uniforms.screenWidth + coord.x);

  let finalColor = vec4f(unpackColor888(pixelBuffer.data[index]), 1.0);
  return finalColor;
}

`;
