import Loc from '../dash3d/type/Loc';
import Tile from '../dash3d/type/Tile';
import TileOverlay from '../dash3d/type/TileOverlay';
import TileUnderlay from '../dash3d/type/TileUnderlay';
import World3D from '../dash3d/World3D';
import {gl} from './Canvas';
import Draw3D from './Draw3D';
import Model from './Model';
import PixMap from './PixMap';
import {mat4, vec3} from 'gl-matrix';

export type Context = WebGL2RenderingContext;

export abstract class WebGLResource {
    protected readonly ctx: Context;

    constructor(ctx: Context) {
        this.ctx = ctx;
    }

    abstract dispose(): void;
}

export class Shader extends WebGLResource {
    readonly shader: WebGLShader;

    constructor(ctx: Context, type: number, source: string) {
        super(ctx);

        const shader: WebGLShader = ctx.createShader(type)!;

        ctx.shaderSource(shader, source);

        ctx.compileShader(shader);

        const success: number = ctx.getShaderParameter(shader, ctx.COMPILE_STATUS);

        if (!success) {
            const log: string | null = ctx.getShaderInfoLog(shader);

            ctx.deleteShader(shader);

            throw Error(`Failed to compile WebGL shader:\n${log}`);
        }

        this.shader = shader;
    }

    dispose(): void {
        this.ctx.deleteShader(this.shader);
    }
}

export class ShaderProgram extends WebGLResource {
    readonly program: WebGLProgram;

    constructor(ctx: Context) {
        super(ctx);

        this.program = ctx.createProgram()!;
    }

    attach(shader: Shader): void {
        this.ctx.attachShader(this.program, shader.shader);
    }

    link(): void {
        const ctx: Context = this.ctx;

        ctx.linkProgram(this.program);

        const success: number = ctx.getProgramParameter(this.program, ctx.LINK_STATUS);

        if (!success) {
            const log: string | null = ctx.getProgramInfoLog(this.program);

            this.dispose();

            throw new Error(`Failed to link shader program: ${log}`);
        }
    }

    use(): void {
        this.ctx.useProgram(this.program);
    }

    dispose(): void {
        this.ctx.deleteProgram(this.program);
    }
}

export function createProgram(ctx: Context, shaders: Iterable<Shader>): ShaderProgram {
    const program: ShaderProgram = new ShaderProgram(ctx);

    for (const shader of shaders) {
        program.attach(shader);
    }

    program.link();

    for (const shader of shaders) {
        shader.dispose();
    }

    return program;
}

class VertexDataBuffer {
    static readonly STRIDE: number = 8 * 4;

    data: Uint8Array;
    view: DataView;

    pos: number = 0;

    constructor(initialVertexCount: number) {
        this.data = new Uint8Array(initialVertexCount * VertexDataBuffer.STRIDE);
        this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    }

    growIfRequired(vertexCount: number): void {
        const byteLengthRequired: number = this.pos + vertexCount * VertexDataBuffer.STRIDE;
        if (this.data.byteLength < byteLengthRequired) {
            const newData: Uint8Array = new Uint8Array(byteLengthRequired * 2);
            newData.set(this.data);
            this.data = newData;
            this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
        }
    }

    // TODO: pack to improve performance/bandwidth
    addVertex(x: number, y: number, z: number, hsl: number, alpha: number, textureId: number, texCoordU: number, texCoordV: number): number {
        this.growIfRequired(1);
        const index: number = this.pos / VertexDataBuffer.STRIDE;
        this.view.setFloat32(this.pos, x, true);
        this.view.setFloat32(this.pos + 4, y, true);
        this.view.setFloat32(this.pos + 8, z, true);
        this.view.setFloat32(this.pos + 12, hsl, true);
        this.view.setFloat32(this.pos + 16, texCoordU, true);
        this.view.setFloat32(this.pos + 20, texCoordV, true);
        this.view.setFloat32(this.pos + 24, textureId + 1, true);
        this.view.setFloat32(this.pos + 28, alpha / 0xff, true);
        this.pos += VertexDataBuffer.STRIDE;
        return index;
    }

    addData(data: Uint8Array): void {
        this.growIfRequired(data.length / VertexDataBuffer.STRIDE);
        this.data.set(data, this.pos);
        this.pos += data.length;
    }
}

class IndexDataBuffer {
    indices: Int32Array;

    pos: number = 0;

    constructor(initialIndexCount: number) {
        this.indices = new Int32Array(initialIndexCount);
    }

    growIfRequired(indexCount: number): void {
        const lengthRequired: number = this.pos + indexCount;
        if (this.indices.length < lengthRequired) {
            const newIndices: Int32Array = new Int32Array(lengthRequired * 2);
            newIndices.set(this.indices);
            this.indices = newIndices;
        }
    }

    addIndices(...indices: number[]): void {
        this.growIfRequired(indices.length);
        for (const index of indices) {
            this.indices[this.pos++] = index;
        }
    }
}

class DrawCommands {
    positions: Int32Array;
    yaws: Int32Array;
    offsets: Int32Array;
    counts: Int32Array;

    count: number = 0;

    constructor(count: number) {
        this.positions = new Int32Array(count * 3);
        this.yaws = new Int32Array(count);
        this.offsets = new Int32Array(count);
        this.counts = new Int32Array(count);
    }

    reset(): void {
        this.count = 0;
    }

    reduce(): void {
        const originalCount: number = this.count;

        for (let i: number = 0; i < originalCount; i++) {
            const x: number = this.positions[i * 3];
            const y: number = this.positions[i * 3 + 1];
            const z: number = this.positions[i * 3 + 2];
            const yaw: number = this.yaws[i];
            const offset: number = this.offsets[i];
            const count: number = this.counts[i];

            if (count === 0) {
                continue;
            }

            for (let j: number = i + 1; j < originalCount; j++) {
                if (this.positions[j * 3] === x && this.positions[j * 3 + 1] === y && this.positions[j * 3 + 2] === z && this.yaws[j] === yaw && offset + this.counts[i] === this.offsets[j]) {
                    this.counts[i] += this.counts[j];
                    this.counts[j] = 0;
                } else {
                    break;
                }
            }
        }
    }

    addCommand(x: number, y: number, z: number, yaw: number, offset: number, count: number): void {
        if (count === 0) {
            return;
        }
        if (this.count >= this.yaws.length) {
            const newPositions: Int32Array = new Int32Array(this.count * 3 * 2);
            const newYaws: Int32Array = new Int32Array(this.count * 2);
            const newOffsets: Int32Array = new Int32Array(this.count * 2);
            const newCounts: Int32Array = new Int32Array(this.count * 2);
            newPositions.set(this.positions);
            newYaws.set(this.yaws);
            newOffsets.set(this.offsets);
            newCounts.set(this.counts);
            this.positions = newPositions;
            this.yaws = newYaws;
            this.offsets = newOffsets;
            this.counts = newCounts;
        }
        this.positions[this.count * 3] = x;
        this.positions[this.count * 3 + 1] = y;
        this.positions[this.count * 3 + 2] = z;
        this.yaws[this.count] = yaw;
        this.offsets[this.count] = offset;
        this.counts[this.count] = count;
        this.count++;
    }
}

interface PixMapTexture {
    lastFrameUsed: number;
    texture: WebGLTexture;
}

interface CachedVertexData {
    frame: number;
    data: Uint8Array;
}

const frameVertSource: string = `
#version 300 es

out vec2 v_texCoord;

const vec2 vertices[3] = vec2[3](
    vec2(-1,-1), 
    vec2(3,-1), 
    vec2(-1, 3)
);

void main() {
    gl_Position = vec4(vertices[gl_VertexID], 0.0, 1.0);
    v_texCoord = gl_Position.xy * 0.5 + 0.5;
}
`.trim();
const frameFragSource: string = `
#version 300 es

precision highp float;

uniform highp sampler2D u_frame;

in vec2 v_texCoord;

out vec4 fragColor;

void main() {
    fragColor = texture(u_frame, v_texCoord);
}
`.trim();

const pixMapVertSource: string = `
#version 300 es

out vec2 v_texCoord;

const vec2 vertices[3] = vec2[3](
    vec2(-1,-1), 
    vec2(3,-1), 
    vec2(-1, 3)
);

void main() {
    gl_Position = vec4(vertices[gl_VertexID], 0.0, 1.0);
    v_texCoord = gl_Position.xy * 0.5 + 0.5;
    // flip y
    v_texCoord.y = 1.0 - v_texCoord.y;
}
`.trim();
const pixMapFragSource: string = `
#version 300 es

precision highp float;

uniform highp sampler2D u_frame;

in vec2 v_texCoord;

out vec4 fragColor;

void main() {
    fragColor = texture(u_frame, v_texCoord).bgra;
    fragColor.a = fragColor == vec4(1.0) ? 0.0 : 1.0;
}
`.trim();

// https://stackoverflow.com/a/17309861
const hslToRgbGlsl: string = `
vec3 hslToRgb(int hsl, float brightness) {
    const float onethird = 1.0 / 3.0;
    const float twothird = 2.0 / 3.0;
    const float rcpsixth = 6.0;

    float hue = float(hsl >> 10) / 64.0 + 0.0078125;
    float sat = float((hsl >> 7) & 0x7) / 8.0 + 0.0625;
    float lum = (float(hsl & 0x7f) / 128.0);

    vec3 xt = vec3(
        rcpsixth * (hue - twothird),
        0.0,
        rcpsixth * (1.0 - hue)
    );

    if (hue < twothird) {
        xt.r = 0.0;
        xt.g = rcpsixth * (twothird - hue);
        xt.b = rcpsixth * (hue      - onethird);
    }

    if (hue < onethird) {
        xt.r = rcpsixth * (onethird - hue);
        xt.g = rcpsixth * hue;
        xt.b = 0.0;
    }

    xt = min( xt, 1.0 );

    float sat2   =  2.0 * sat;
    float satinv =  1.0 - sat;
    float luminv =  1.0 - lum;
    float lum2m1 = (2.0 * lum) - 1.0;
    vec3  ct     = (sat2 * xt) + satinv;

    vec3 rgb;
    if (lum >= 0.5)
         rgb = (luminv * ct) + lum2m1;
    else rgb =  lum    * ct;

    return pow(rgb, vec3(brightness));
}
`;

const mainVertSource: string = `
#version 300 es

#define TEXTURE_ANIM_UNIT (1.0f / 128.0f)

uniform float u_time;
uniform float u_brightness;
uniform mat4 u_viewProjectionMatrix;

uniform float u_angle;
uniform vec3 u_translation;

layout(location = 0) in vec4 a_position;
layout(location = 1) in vec4 a_texCoord;

out vec4 v_color;
out vec3 v_texCoord;

${hslToRgbGlsl}

mat4 rotationY( in float angle ) {
    return mat4(cos(angle),		0,		sin(angle),	0,
                         0,		1.0,			 0,	0,
                -sin(angle),	0,		cos(angle),	0,
                        0, 		0,				0,	1);
}

void main() {
    gl_Position = rotationY(u_angle) * vec4(a_position.xyz, 1.0);
    gl_Position.xyz += u_translation;
    gl_Position = u_viewProjectionMatrix * gl_Position;
    float textureId = a_texCoord.z - 1.0;
    if (textureId >= 0.0) {
        v_color.r = a_position.w / 127.0;
    } else {
        int hsl = int(a_position.w);
        v_color = vec4(hslToRgb(hsl, u_brightness), a_texCoord.w);
    }
    v_texCoord = a_texCoord.xyz;
    // scrolling textures
    if (textureId == 17.0 || textureId == 24.0) {
        v_texCoord.y += u_time / 0.02 * -2.0 * TEXTURE_ANIM_UNIT;
    }
}
`.trim();
const mainFragSource: string = `
#version 300 es

precision highp float;

uniform float u_brightness;

uniform highp sampler2DArray u_textures;

in vec4 v_color;
in vec3 v_texCoord;

out vec4 fragColor;

vec3 getShadedColor(int rgb, int shadowFactor) {
    int shadowFactors[4] = int[](
        rgb & 0xf8f8ff,
        (rgb - (rgb >> 3)) & 0xf8f8ff,
        (rgb - (rgb >> 2)) & 0xf8f8ff,
        (rgb - (rgb >> 2) - (rgb >> 3)) & 0xf8f8ff
    );
    rgb = shadowFactors[shadowFactor % 4] >> (shadowFactor / 4);

    return vec3(float((rgb >> 16) & 0xff) / 255.0, float((rgb >> 8) & 0xff) / 255.0, float(rgb & 0xff) / 255.0);
}

void main() {
    if (v_texCoord.z > 0.0) {
        // emulate texture color shading
        vec4 texColor = texture(u_textures, v_texCoord).bgra;
        int rgb = int(texColor.r * 255.0) << 16 | int(texColor.g * 255.0) << 8 | int(texColor.b * 255.0);
        int shadowFactor = int(floor(v_color.r / 0.125));

        fragColor.rgb = getShadedColor(rgb, shadowFactor);
        fragColor.a = texColor.a;
    } else {
        // emulate color banding
        fragColor.rgb = round(v_color.rgb * 64.0) / 64.0;
        fragColor.a = v_color.a;
    }
}
`.trim();

const PI: number = Math.PI;
const TAU: number = PI * 2;
const RS_TO_RADIANS: number = TAU / 2048.0;

const FRUSTUM_SCALE: number = 25.0 / 256.0;
const DEFAULT_ZOOM: number = 512;

const NEAR: number = 50;
const FAR: number = 3500;

// TODO: properly implement a toggle for this
// TODO: try using a separate buffer for static models to reduce bandwidth
export class Renderer {
    static enabled: boolean = true;

    static frame: number = 0;

    static pixMapTextures: Map<PixMap, PixMapTexture> = new Map();

    static drawCommands: DrawCommands = new DrawCommands(1024);

    static frameProgram: ShaderProgram;
    static frameLoc: WebGLUniformLocation;

    static pixMapProgram: ShaderProgram;
    static pixMapLoc: WebGLUniformLocation;

    static mainProgram: ShaderProgram;
    static timeLoc: WebGLUniformLocation;
    static brightnessLoc: WebGLUniformLocation;
    static viewProjectionMatrixLoc: WebGLUniformLocation;
    static angleLoc: WebGLUniformLocation;
    static translationLoc: WebGLUniformLocation;
    static texturesLoc: WebGLUniformLocation;
    static positionAttrLoc: number;
    static texCoordAttrLoc: number;

    static areaViewport: PixMap;
    static viewportWidth: number;
    static viewportHeight: number;
    static viewportFramebuffer?: WebGLFramebuffer;
    static viewportColorTexture: WebGLTexture;
    static viewportDepthBuffer: WebGLRenderbuffer;

    static isDrawingScene: boolean = false;

    static textureArray: WebGLTexture | null;

    static brightness: number = 0.9;

    static cameraPos: vec3 = vec3.create();
    static cameraYaw: number = 0;
    static cameraPitch: number = 0;

    static projectionMatrix: mat4 = mat4.create();
    static cameraMatrix: mat4 = mat4.create();
    static viewMatrix: mat4 = mat4.create();
    static viewProjectionMatrix: mat4 = mat4.create();

    static vertexDataBuffer: VertexDataBuffer = new VertexDataBuffer(1024);
    static indexDataBuffer: IndexDataBuffer = new IndexDataBuffer(1024 * 2);

    static vertexArray: WebGLVertexArrayObject;

    static vertexBuffer: WebGLBuffer | null;
    static indexBuffer: WebGLBuffer | null;

    static modelStartIndex: number = 0;
    static modelElementOffset: number = 0;

    static modelStartIndexMap: Map<Model, number> = new Map();
    static modelVertexDataCache: Map<Model, CachedVertexData> = new Map();
    static modelsToCache: Set<Model> = new Set();

    static init(): void {
        gl.enable(gl.CULL_FACE);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        const frameVertShader: Shader = new Shader(gl, gl.VERTEX_SHADER, frameVertSource);
        const frameFragShader: Shader = new Shader(gl, gl.FRAGMENT_SHADER, frameFragSource);
        Renderer.frameProgram = createProgram(gl, [frameVertShader, frameFragShader]);
        Renderer.frameLoc = gl.getUniformLocation(Renderer.frameProgram.program, 'u_frame')!;

        const pixMapVertShader: Shader = new Shader(gl, gl.VERTEX_SHADER, pixMapVertSource);
        const pixMapFragShader: Shader = new Shader(gl, gl.FRAGMENT_SHADER, pixMapFragSource);
        Renderer.pixMapProgram = createProgram(gl, [pixMapVertShader, pixMapFragShader]);
        Renderer.pixMapLoc = gl.getUniformLocation(Renderer.pixMapProgram.program, 'u_frame')!;

        const mainVertShader: Shader = new Shader(gl, gl.VERTEX_SHADER, mainVertSource);
        const mainFragShader: Shader = new Shader(gl, gl.FRAGMENT_SHADER, mainFragSource);
        Renderer.mainProgram = createProgram(gl, [mainVertShader, mainFragShader]);
        Renderer.timeLoc = gl.getUniformLocation(Renderer.mainProgram.program, 'u_time')!;
        Renderer.brightnessLoc = gl.getUniformLocation(Renderer.mainProgram.program, 'u_brightness')!;
        Renderer.viewProjectionMatrixLoc = gl.getUniformLocation(Renderer.mainProgram.program, 'u_viewProjectionMatrix')!;
        Renderer.angleLoc = gl.getUniformLocation(Renderer.mainProgram.program, 'u_angle')!;
        Renderer.translationLoc = gl.getUniformLocation(Renderer.mainProgram.program, 'u_translation')!;
        Renderer.texturesLoc = gl.getUniformLocation(Renderer.mainProgram.program, 'u_textures')!;
        Renderer.positionAttrLoc = gl.getAttribLocation(Renderer.mainProgram.program, 'a_position');
        Renderer.texCoordAttrLoc = gl.getAttribLocation(Renderer.mainProgram.program, 'a_texCoord');

        const vertexArray: WebGLVertexArrayObject = gl.createVertexArray()!;
        gl.bindVertexArray(vertexArray);
        gl.enableVertexAttribArray(Renderer.positionAttrLoc);
        gl.enableVertexAttribArray(Renderer.texCoordAttrLoc);
        Renderer.vertexArray = vertexArray;
        gl.bindVertexArray(null);
    }

    static setBrightness(brightness: number): void {
        Renderer.brightness = brightness;
        Renderer.initTextureArray(true);
    }

    static initTextureArray(force: boolean = false): void {
        if (Renderer.textureArray && !force) {
            return;
        }
        if (Renderer.textureArray) {
            gl.deleteTexture(Renderer.textureArray);
        }
        const textureSize: number = 128;
        const pixelCount: number = textureSize * textureSize;

        const textureCount: number = Draw3D.textureCount;
        const textureArrayLayers: number = textureCount + 1;

        const textureArray: WebGLTexture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, textureArray);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);

        const pixels: Int32Array = new Int32Array(textureArrayLayers * pixelCount);
        // White texture
        pixels.fill(0xffffffff, 0, pixelCount);

        for (let t: number = 0; t < textureCount; t++) {
            const texels: Int32Array | null = Draw3D.getTexels(t);
            if (!texels) {
                continue;
            }
            for (let i: number = 0; i < pixelCount; i++) {
                let rgb: number = texels[i];
                if (rgb !== 0) {
                    rgb |= 0xff000000;
                }
                pixels[(t + 1) * pixelCount + i] = rgb;
            }
        }

        gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, textureSize, textureSize, textureArrayLayers, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.buffer));

        Renderer.textureArray = textureArray;
    }

    static startFrame(): void {
        Renderer.frame++;
        Renderer.drawCommands.count = 0;
        Renderer.modelStartIndexMap.clear();
        if (!Renderer.enabled) {
            return;
        }
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        // gl.clear(gl.COLOR_BUFFER_BIT);
    }

    static setFrustumProjectionMatrix(matrix: mat4, offsetX: number, offsetY: number, centerX: number, centerY: number, width: number, height: number, yaw: number, pitch: number, zoom: number): mat4 {
        const left: number = ((offsetX - centerX) << 9) / zoom;
        const right: number = ((offsetX + width - centerX) << 9) / zoom;
        const top: number = ((offsetY - centerY) << 9) / zoom;
        const bottom: number = ((offsetY + height - centerY) << 9) / zoom;

        mat4.identity(matrix);
        mat4.frustum(matrix, left * FRUSTUM_SCALE, right * FRUSTUM_SCALE, -bottom * FRUSTUM_SCALE, -top * FRUSTUM_SCALE, NEAR, FAR);

        mat4.rotateX(matrix, matrix, PI);
        if (pitch !== 0) {
            mat4.rotateX(matrix, matrix, pitch * RS_TO_RADIANS);
        }
        if (yaw !== 0) {
            mat4.rotateY(matrix, matrix, yaw * RS_TO_RADIANS);
        }

        return matrix;
    }

    static setCameraMatrix(matrix: mat4, pos: vec3): mat4 {
        mat4.identity(matrix);
        mat4.translate(matrix, matrix, pos);
        return matrix;
    }

    static drawPixMap(pixMap: PixMap, x: number, y: number): boolean {
        let pixMapTexture: PixMapTexture | undefined = Renderer.pixMapTextures.get(pixMap);
        if (!pixMapTexture) {
            // console.log("Creating texture for pixMap", x, y, pixMap.width, pixMap.height);
            const texture: WebGLTexture = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, pixMap.width, pixMap.height);
            pixMapTexture = {
                lastFrameUsed: Renderer.frame,
                texture: texture
            };
            Renderer.pixMapTextures.set(pixMap, pixMapTexture);
        } else {
            pixMapTexture.lastFrameUsed = Renderer.frame;
        }

        // Render scene
        if (pixMap === Renderer.areaViewport && Renderer.enabled) {
            const viewportWidth: number = pixMap.width;
            const viewportHeight: number = pixMap.height;
            if (Renderer.viewportFramebuffer === undefined || Renderer.viewportWidth !== viewportWidth || Renderer.viewportHeight !== viewportHeight) {
                if (Renderer.viewportFramebuffer !== undefined) {
                    gl.deleteFramebuffer(Renderer.viewportFramebuffer);
                    gl.deleteTexture(Renderer.viewportColorTexture);
                    gl.deleteRenderbuffer(Renderer.viewportDepthBuffer);
                }
                // console.log("Creating viewport framebuffer", x, y, pixMap.width, pixMap.height);
                Renderer.viewportFramebuffer = gl.createFramebuffer()!;
                Renderer.viewportWidth = viewportWidth;
                Renderer.viewportHeight = viewportHeight;
                const colorTexture: WebGLTexture = (Renderer.viewportColorTexture = gl.createTexture()!);
                gl.bindTexture(gl.TEXTURE_2D, colorTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, viewportWidth, viewportHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

                const depthBuffer: WebGLRenderbuffer = (Renderer.viewportDepthBuffer = gl.createRenderbuffer()!);
                gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
                gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, viewportWidth, viewportHeight);

                gl.bindFramebuffer(gl.FRAMEBUFFER, Renderer.viewportFramebuffer);

                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
            } else {
                gl.bindFramebuffer(gl.FRAMEBUFFER, Renderer.viewportFramebuffer);
            }

            // gl.enable(gl.DEPTH_TEST);

            const centerX: number = Draw3D.centerX;
            const centerY: number = Draw3D.centerY;

            gl.viewport(0, 0, viewportWidth, viewportHeight);

            gl.clearColor(0.0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            Renderer.mainProgram.use();

            gl.uniform1f(Renderer.timeLoc, performance.now() / 1000);
            gl.uniform1f(Renderer.brightnessLoc, Renderer.brightness);

            Renderer.cameraPos[0] = World3D.eyeX;
            Renderer.cameraPos[1] = World3D.eyeY;
            Renderer.cameraPos[2] = World3D.eyeZ;
            const yaw: number = Renderer.cameraYaw;
            const pitch: number = Renderer.cameraPitch;
            const zoom: number = DEFAULT_ZOOM;
            Renderer.setFrustumProjectionMatrix(Renderer.projectionMatrix, 0, 0, centerX, centerY, viewportWidth, viewportHeight, yaw, pitch, zoom);
            Renderer.setCameraMatrix(Renderer.cameraMatrix, Renderer.cameraPos);
            mat4.invert(Renderer.viewMatrix, Renderer.cameraMatrix);
            mat4.multiply(Renderer.viewProjectionMatrix, Renderer.projectionMatrix, Renderer.viewMatrix);

            gl.uniformMatrix4fv(Renderer.viewProjectionMatrixLoc, false, Renderer.viewProjectionMatrix);

            if (Renderer.vertexBuffer) {
                gl.deleteBuffer(Renderer.vertexBuffer);
                Renderer.vertexBuffer = null;
            }
            if (Renderer.indexBuffer) {
                gl.deleteBuffer(Renderer.indexBuffer);
                Renderer.indexBuffer = null;
            }

            const vertexDataBuffer: VertexDataBuffer = Renderer.vertexDataBuffer;
            const indexDataBuffer: IndexDataBuffer = Renderer.indexDataBuffer;

            const vertexCount: number = vertexDataBuffer.pos / VertexDataBuffer.STRIDE;
            const elementCount: number = indexDataBuffer.pos;

            if (elementCount > 0) {
                gl.bindTexture(gl.TEXTURE_2D_ARRAY, Renderer.textureArray);

                gl.bindVertexArray(Renderer.vertexArray);

                Renderer.vertexBuffer = gl.createBuffer()!;
                gl.bindBuffer(gl.ARRAY_BUFFER, Renderer.vertexBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, vertexDataBuffer.data, gl.STATIC_DRAW, 0, vertexDataBuffer.pos);

                gl.vertexAttribPointer(Renderer.positionAttrLoc, 4, gl.FLOAT, false, VertexDataBuffer.STRIDE, 0);
                gl.vertexAttribPointer(Renderer.texCoordAttrLoc, 4, gl.FLOAT, false, VertexDataBuffer.STRIDE, 4 * 4);

                Renderer.indexBuffer = gl.createBuffer()!;
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, Renderer.indexBuffer);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexDataBuffer.indices, gl.STATIC_DRAW, 0, indexDataBuffer.pos);

                const position: Float32Array = new Float32Array(3);

                let drawCount: number = 0;
                const drawCommands: DrawCommands = Renderer.drawCommands;
                drawCommands.reduce();
                for (let i: number = 0; i < drawCommands.count; i++) {
                    const offset: number = drawCommands.offsets[i];
                    const count: number = drawCommands.counts[i];
                    if (count === 0) {
                        continue;
                    }
                    const angle: number = ((2048 - drawCommands.yaws[i]) & 0x7ff) * RS_TO_RADIANS;
                    position[0] = drawCommands.positions[i * 3];
                    position[1] = drawCommands.positions[i * 3 + 1];
                    position[2] = drawCommands.positions[i * 3 + 2];
                    gl.uniform1f(Renderer.angleLoc, angle);
                    gl.uniform3fv(Renderer.translationLoc, position);
                    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, offset * 4);
                    drawCount++;
                }

                gl.bindVertexArray(null);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            // gl.disable(gl.DEPTH_TEST);

            this.drawTexture(Renderer.viewportColorTexture, x, y, viewportWidth, viewportHeight);

            // Draw right side 1 pixel border
            this.drawTexture(null, x + viewportWidth - 1, y, 1, viewportHeight);
        }

        const pixels: Uint8Array = new Uint8Array(pixMap.pixels.buffer);

        gl.bindTexture(gl.TEXTURE_2D, pixMapTexture.texture);

        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pixMap.width, pixMap.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        Renderer.drawPixMapTexture(pixMapTexture.texture, x, y, pixMap.width, pixMap.height);

        return Renderer.enabled;
    }

    static drawTexture(texture: WebGLTexture | null, x: number, y: number, width: number, height: number): void {
        Renderer.frameProgram.use();

        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.viewport(x, gl.canvas.height - y - height, width, height);
        // gl.uniform1i(Renderer.frameLoc, 0);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    static drawPixMapTexture(texture: WebGLTexture, x: number, y: number, width: number, height: number): void {
        Renderer.pixMapProgram.use();

        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.viewport(x, gl.canvas.height - y - height, width, height);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    static startDrawScene(): void {
        Renderer.isDrawingScene = true;
        Renderer.vertexDataBuffer.pos = 0;
        Renderer.indexDataBuffer.pos = 0;
        if (Renderer.enabled) {
            Renderer.initTextureArray();
        }
    }

    static endDrawScene(): void {
        Renderer.isDrawingScene = false;
    }

    static drawTileUnderlay(world: World3D, underlay: TileUnderlay, level: number, tileX: number, tileZ: number): boolean {
        if (!Renderer.enabled) {
            return false;
        }
        if (underlay.southwestColor === 12345678 && underlay.northeastColor === 12345678) {
            return true;
        }
        const x0: number = tileX << 7;
        const x1: number = (tileX + 1) << 7;
        const z0: number = tileZ << 7;
        const z1: number = (tileZ + 1) << 7;

        const y00: number = world.levelHeightmaps[level][tileX][tileZ];
        const y10: number = world.levelHeightmaps[level][tileX + 1][tileZ];
        const y11: number = world.levelHeightmaps[level][tileX + 1][tileZ + 1];
        const y01: number = world.levelHeightmaps[level][tileX][tileZ + 1];

        const vertexDataBuffer: VertexDataBuffer = Renderer.vertexDataBuffer;
        const indexDataBuffer: IndexDataBuffer = Renderer.indexDataBuffer;

        const textureId: number = underlay.textureId;
        const texCoordU00: number = 0;
        const texCoordV00: number = 0;
        const texCoordU10: number = 1;
        const texCoordV10: number = 0;
        const texCoordU11: number = 1;
        const texCoordV11: number = 1;
        const texCoordU01: number = 0;
        const texCoordV01: number = 1;

        const elementOffset: number = indexDataBuffer.pos;

        // Software renderer has wrong texture coordinates
        if (underlay.northeastColor !== 12345678) {
            if (underlay.flat) {
                const index11: number = vertexDataBuffer.addVertex(x1, y11, z1, underlay.northeastColor, 0xff, textureId, texCoordU11, texCoordV11);
                const index01: number = vertexDataBuffer.addVertex(x0, y01, z1, underlay.northwestColor, 0xff, textureId, texCoordU01, texCoordV01);
                const index10: number = vertexDataBuffer.addVertex(x1, y10, z0, underlay.southeastColor, 0xff, textureId, texCoordU10, texCoordV10);
                indexDataBuffer.addIndices(index11, index01, index10);
            } else {
                const index11: number = vertexDataBuffer.addVertex(x1, y11, z1, underlay.northeastColor, 0xff, textureId, texCoordU00, texCoordV00);
                const index01: number = vertexDataBuffer.addVertex(x0, y01, z1, underlay.northwestColor, 0xff, textureId, texCoordU10, texCoordV10);
                const index10: number = vertexDataBuffer.addVertex(x1, y10, z0, underlay.southeastColor, 0xff, textureId, texCoordU01, texCoordV01);
                indexDataBuffer.addIndices(index11, index01, index10);
            }
        }
        if (underlay.southwestColor !== 12345678) {
            const index00: number = vertexDataBuffer.addVertex(x0, y00, z0, underlay.southwestColor, 0xff, textureId, texCoordU00, texCoordV00);
            const index10: number = vertexDataBuffer.addVertex(x1, y10, z0, underlay.southeastColor, 0xff, textureId, texCoordU10, texCoordV10);
            const index01: number = vertexDataBuffer.addVertex(x0, y01, z1, underlay.northwestColor, 0xff, textureId, texCoordU01, texCoordV01);
            indexDataBuffer.addIndices(index00, index10, index01);
        }

        Renderer.drawCommands.addCommand(0, 0, 0, 0, elementOffset, indexDataBuffer.pos - elementOffset);

        return true;
    }

    static tmpOverlayU: Float32Array = new Float32Array(6);
    static tmpOverlayV: Float32Array = new Float32Array(6);

    static drawTileOverlay(world: World3D, overlay: TileOverlay, tileX: number, tileZ: number): boolean {
        if (!Renderer.enabled) {
            return false;
        }
        const vertexDataBuffer: VertexDataBuffer = Renderer.vertexDataBuffer;
        const indexDataBuffer: IndexDataBuffer = Renderer.indexDataBuffer;

        const offsetX: number = tileX << 7;
        const offsetZ: number = tileZ << 7;

        const elementOffset: number = indexDataBuffer.pos;

        const vertexCount: number = overlay.vertexX.length;
        const triangleCount: number = overlay.triangleVertexA.length;

        if (overlay.triangleTextureIds) {
            for (let i: number = 0; i < vertexCount; i++) {
                const x: number = overlay.vertexX[i] - offsetX;
                const z: number = overlay.vertexZ[i] - offsetZ;

                Renderer.tmpOverlayU[i] = x / 128.0;
                Renderer.tmpOverlayV[i] = z / 128.0;
            }
        }

        for (let i: number = 0; i < triangleCount; i++) {
            const a: number = overlay.triangleVertexA[i];
            const b: number = overlay.triangleVertexB[i];
            const c: number = overlay.triangleVertexC[i];

            const xa: number = overlay.vertexX[a];
            const ya: number = overlay.vertexY[a];
            const za: number = overlay.vertexZ[a];

            const xb: number = overlay.vertexX[b];
            const yb: number = overlay.vertexY[b];
            const zb: number = overlay.vertexZ[b];

            const xc: number = overlay.vertexX[c];
            const yc: number = overlay.vertexY[c];
            const zc: number = overlay.vertexZ[c];

            const colorA: number = overlay.triangleColorA[i];
            const colorB: number = overlay.triangleColorB[i];
            const colorC: number = overlay.triangleColorC[i];

            const textureId: number = overlay.triangleTextureIds?.[i] ?? -1;
            if (textureId === -1 && colorA === 12345678) {
                continue;
            }

            if (overlay.flat) {
                const indexA: number = vertexDataBuffer.addVertex(xa, ya, za, colorA, 0xff, textureId, Renderer.tmpOverlayU[a], Renderer.tmpOverlayV[a]);
                const indexB: number = vertexDataBuffer.addVertex(xb, yb, zb, colorB, 0xff, textureId, Renderer.tmpOverlayU[b], Renderer.tmpOverlayV[b]);
                const indexC: number = vertexDataBuffer.addVertex(xc, yc, zc, colorC, 0xff, textureId, Renderer.tmpOverlayU[c], Renderer.tmpOverlayV[c]);

                indexDataBuffer.addIndices(indexA, indexB, indexC);
            } else {
                const indexA: number = vertexDataBuffer.addVertex(xa, ya, za, colorA, 0xff, textureId, Renderer.tmpOverlayU[0], Renderer.tmpOverlayV[0]);
                const indexB: number = vertexDataBuffer.addVertex(xb, yb, zb, colorB, 0xff, textureId, Renderer.tmpOverlayU[1], Renderer.tmpOverlayV[1]);
                const indexC: number = vertexDataBuffer.addVertex(xc, yc, zc, colorC, 0xff, textureId, Renderer.tmpOverlayU[3], Renderer.tmpOverlayV[3]);

                indexDataBuffer.addIndices(indexA, indexB, indexC);
            }
        }

        Renderer.drawCommands.addCommand(0, 0, 0, 0, elementOffset, indexDataBuffer.pos - elementOffset);

        return true;
    }

    static cacheModelVertexData(model: Model, resetData: boolean): void {
        if (Renderer.modelVertexDataCache.has(model)) {
            return;
        }
        const vertexDataBuffer: VertexDataBuffer = Renderer.vertexDataBuffer;
        const startPos: number = vertexDataBuffer.pos;
        Renderer.addModelVertexData(vertexDataBuffer, model);
        const endPos: number = vertexDataBuffer.pos;
        if (resetData) {
            vertexDataBuffer.pos = startPos;
        }
        const length: number = endPos - startPos;
        if (length > 0) {
            const data: Uint8Array = vertexDataBuffer.data.slice(startPos, endPos);
            Renderer.modelVertexDataCache.set(model, {frame: Renderer.frame, data});
        }
    }

    static onSceneLoaded(world: World3D | null): void {
        if (!world || !Renderer.enabled) {
            return;
        }
        // Cache static model vertex data

        Renderer.modelVertexDataCache.clear();
        Renderer.modelsToCache.clear();

        for (let level: number = 0; level < world.maxLevel; level++) {
            for (let x: number = 0; x < world.maxTileX; x++) {
                for (let z: number = 0; z < world.maxTileZ; z++) {
                    const tile: Tile | null = world.levelTiles[level][x][z];
                    if (!tile) {
                        continue;
                    }
                    const wallModelA: Model | null | undefined = tile.wall?.modelA;
                    const wallModelB: Model | null | undefined = tile.wall?.modelB;
                    const wallDecModel: Model | null | undefined = tile.wallDecoration?.model;
                    const groundDecModel: Model | null | undefined = tile.groundDecoration?.model;
                    if (wallModelA) {
                        Renderer.modelsToCache.add(wallModelA);
                        // Renderer.cacheModelVertexData(wallModelA);
                    }
                    if (wallModelB) {
                        Renderer.modelsToCache.add(wallModelB);
                        // Renderer.cacheModelVertexData(wallModelB);
                    }
                    if (wallDecModel) {
                        Renderer.modelsToCache.add(wallDecModel);
                        // Renderer.cacheModelVertexData(wallDecModel);
                    }
                    if (groundDecModel) {
                        Renderer.modelsToCache.add(groundDecModel);
                        // Renderer.cacheModelVertexData(groundDecModel);
                    }
                    for (const loc of tile.locs) {
                        if (!loc) {
                            continue;
                        }
                        const model: Model | null = loc.model;
                        if (!model) {
                            continue;
                        }
                        Renderer.modelsToCache.add(model);
                        // Renderer.cacheModelVertexData(model);
                    }
                }
            }
        }

        // console.log("Caching", Renderer.modelsToCache.size, "models");
    }

    static onSceneReset(world: World3D): void {
        Renderer.modelStartIndexMap.clear();
        Renderer.modelVertexDataCache.clear();
        Renderer.modelsToCache.clear();
    }

    static addModelVertexData(vertexDataBuffer: VertexDataBuffer, model: Model): void {
        const triangleColorsA: Int32Array | null = model.faceColorA;
        const triangleColorsB: Int32Array | null = model.faceColorB;
        const triangleColorsC: Int32Array | null = model.faceColorC;

        if (!triangleColorsA || !triangleColorsB || !triangleColorsC) {
            return;
        }

        const verticesX: Int32Array = model.vertexX;
        const verticesY: Int32Array = model.vertexY;
        const verticesZ: Int32Array = model.vertexZ;

        const triangleA: Int32Array = model.faceVertexA;
        const triangleB: Int32Array = model.faceVertexB;
        const triangleC: Int32Array = model.faceVertexC;

        const triangleColors: Int32Array | null = model.faceColor;

        const triangleAlphas: Int32Array | null = model.faceAlpha;

        const triangleInfos: Int32Array | null = model.faceInfo;

        const textureMappingP: Int32Array = model.texturedVertexA;
        const textureMappingM: Int32Array = model.texturedVertexB;
        const textureMappingN: Int32Array = model.texturedVertexC;

        const triangleCount: number = model.faceCount;
        for (let t: number = 0; t < triangleCount; t++) {
            const a: number = triangleA[t];
            const b: number = triangleB[t];
            const c: number = triangleC[t];

            const xa: number = verticesX[a];
            const ya: number = verticesY[a];
            const za: number = verticesZ[a];

            const xb: number = verticesX[b];
            const yb: number = verticesY[b];
            const zb: number = verticesZ[b];

            const xc: number = verticesX[c];
            const yc: number = verticesY[c];
            const zc: number = verticesZ[c];

            const colorA: number = triangleColorsA[t];
            let colorB: number = triangleColorsB[t];
            let colorC: number = triangleColorsC[t];

            let alpha: number = 0xff;
            if (triangleAlphas) {
                alpha = 0xff - triangleAlphas[t];
            }

            let info: number = 0;
            if (triangleInfos) {
                info = triangleInfos[t];
            }

            const type: number = info & 0x3;

            // Flat shading
            if (type === 1 || type === 3) {
                colorC = colorB = colorA;
            }

            let textureId: number = -1;

            let u0: number = 0.0;
            let v0: number = 0.0;
            let u1: number = 0.0;
            let v1: number = 0.0;
            let u2: number = 0.0;
            let v2: number = 0.0;

            // Textured
            if ((type === 2 || type === 3) && triangleColors) {
                textureId = triangleColors[t];

                const texCoord: number = info >> 2;
                const p: number = textureMappingP[texCoord];
                const m: number = textureMappingM[texCoord];
                const n: number = textureMappingN[texCoord];

                const vx: number = verticesX[p];
                const vy: number = verticesY[p];
                const vz: number = verticesZ[p];

                const f_882_: number = verticesX[m] - vx;
                const f_883_: number = verticesY[m] - vy;
                const f_884_: number = verticesZ[m] - vz;
                const f_885_: number = verticesX[n] - vx;
                const f_886_: number = verticesY[n] - vy;
                const f_887_: number = verticesZ[n] - vz;
                const f_888_: number = verticesX[a] - vx;
                const f_889_: number = verticesY[a] - vy;
                const f_890_: number = verticesZ[a] - vz;
                const f_891_: number = verticesX[b] - vx;
                const f_892_: number = verticesY[b] - vy;
                const f_893_: number = verticesZ[b] - vz;
                const f_894_: number = verticesX[c] - vx;
                const f_895_: number = verticesY[c] - vy;
                const f_896_: number = verticesZ[c] - vz;

                const f_897_: number = f_883_ * f_887_ - f_884_ * f_886_;
                const f_898_: number = f_884_ * f_885_ - f_882_ * f_887_;
                const f_899_: number = f_882_ * f_886_ - f_883_ * f_885_;
                let f_900_: number = f_886_ * f_899_ - f_887_ * f_898_;
                let f_901_: number = f_887_ * f_897_ - f_885_ * f_899_;
                let f_902_: number = f_885_ * f_898_ - f_886_ * f_897_;
                let f_903_: number = 1.0 / (f_900_ * f_882_ + f_901_ * f_883_ + f_902_ * f_884_);

                u0 = (f_900_ * f_888_ + f_901_ * f_889_ + f_902_ * f_890_) * f_903_;
                u1 = (f_900_ * f_891_ + f_901_ * f_892_ + f_902_ * f_893_) * f_903_;
                u2 = (f_900_ * f_894_ + f_901_ * f_895_ + f_902_ * f_896_) * f_903_;

                f_900_ = f_883_ * f_899_ - f_884_ * f_898_;
                f_901_ = f_884_ * f_897_ - f_882_ * f_899_;
                f_902_ = f_882_ * f_898_ - f_883_ * f_897_;
                f_903_ = 1.0 / (f_900_ * f_885_ + f_901_ * f_886_ + f_902_ * f_887_);

                v0 = (f_900_ * f_888_ + f_901_ * f_889_ + f_902_ * f_890_) * f_903_;
                v1 = (f_900_ * f_891_ + f_901_ * f_892_ + f_902_ * f_893_) * f_903_;
                v2 = (f_900_ * f_894_ + f_901_ * f_895_ + f_902_ * f_896_) * f_903_;
            }

            vertexDataBuffer.addVertex(xa, ya, za, colorA, alpha, textureId, u0, v0);
            vertexDataBuffer.addVertex(xb, yb, zb, colorB, alpha, textureId, u1, v1);
            vertexDataBuffer.addVertex(xc, yc, zc, colorC, alpha, textureId, u2, v2);
        }
    }

    static startDrawModel(model: Model, yaw: number, relativeX: number, relativeY: number, relativeZ: number, bitset: number): void {
        if (!Renderer.enabled || !Renderer.isDrawingScene) {
            return;
        }
        const vertexDataBuffer: VertexDataBuffer = Renderer.vertexDataBuffer;
        const indexDataBuffer: IndexDataBuffer = Renderer.indexDataBuffer;

        const modelStartIndex: number | undefined = Renderer.modelStartIndexMap.get(model);
        if (modelStartIndex !== undefined) {
            Renderer.modelStartIndex = modelStartIndex;
            Renderer.modelElementOffset = indexDataBuffer.pos;
            return;
        }

        const triangleColorsA: Int32Array | null = model.faceColorA;
        const triangleColorsB: Int32Array | null = model.faceColorB;
        const triangleColorsC: Int32Array | null = model.faceColorC;

        if (!triangleColorsA || !triangleColorsB || !triangleColorsC) {
            return;
        }

        const vertexDataStartPos: number = vertexDataBuffer.pos;
        Renderer.modelStartIndex = vertexDataStartPos / VertexDataBuffer.STRIDE;
        Renderer.modelElementOffset = indexDataBuffer.pos;

        Renderer.modelStartIndexMap.set(model, Renderer.modelStartIndex);

        const cachedVertexData: CachedVertexData | undefined = Renderer.modelVertexDataCache.get(model);
        if (cachedVertexData) {
            vertexDataBuffer.addData(cachedVertexData.data);
            return;
        }

        if (Renderer.modelsToCache.has(model)) {
            Renderer.cacheModelVertexData(model, false);
        } else {
            Renderer.addModelVertexData(vertexDataBuffer, model);
        }
    }

    static endDrawModel(model: Model, yaw: number, relativeX: number, relativeY: number, relativeZ: number, bitset: number): void {
        if (!Renderer.enabled || !Renderer.isDrawingScene) {
            return;
        }

        const elementCount: number = Renderer.indexDataBuffer.pos - Renderer.modelElementOffset;

        if (elementCount > 0) {
            const x: number = relativeX + World3D.eyeX;
            const y: number = relativeY + World3D.eyeY;
            const z: number = relativeZ + World3D.eyeZ;

            Renderer.drawCommands.addCommand(x, y, z, yaw, Renderer.modelElementOffset, elementCount);
        }
    }

    static drawModelTriangle(model: Model, index: number): boolean {
        if (!Renderer.enabled || !Renderer.isDrawingScene) {
            return false;
        }

        const startIndex: number = Renderer.modelStartIndex + index * 3;

        Renderer.indexDataBuffer.addIndices(startIndex, startIndex + 1, startIndex + 2);

        return true;
    }

    static endFrame(): void {
        for (const [pixMap, pixMapTexture] of Renderer.pixMapTextures) {
            if (Renderer.frame - pixMapTexture.lastFrameUsed > 5) {
                gl.deleteTexture(pixMapTexture.texture);
                Renderer.pixMapTextures.delete(pixMap);
            }
        }
    }
}

Renderer.init();
