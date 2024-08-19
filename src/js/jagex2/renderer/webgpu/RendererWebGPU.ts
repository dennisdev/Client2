import World3D from '../../dash3d/World3D';
import Draw3D from '../../graphics/Draw3D';
import {Renderer} from '../Renderer';
import {SHADER_CODE as computeRasterizerShaderCode} from './shaders/compute-rasterizer.wgsl';
import {SHADER_CODE as fullscreenPixelsShaderCode} from './shaders/fullscreen-pixels.wgsl';

const MAX_TRIANGLES: number = 100000;

const TEXTURE_COUNT: number = 50;

const TEXTURE_SIZE: number = 128;
const TEXTURE_PIXEL_COUNT: number = TEXTURE_SIZE * TEXTURE_SIZE;

const PALETTE_BYTES: number = 65536 * 4;
const TEXTURES_TRANSLUCENT_BYTES: number = TEXTURE_COUNT * 4;
const TEXTURES_BYTES: number = TEXTURE_COUNT * TEXTURE_PIXEL_COUNT * 4 * 4;

export class RendererWebGPU extends Renderer {
    device: GPUDevice;
    context: GPUCanvasContext;

    uniformBuffer!: GPUBuffer;

    pixelBuffer!: GPUBuffer;
    depthBuffer!: GPUBuffer;

    // Lookup tables
    lutsBuffer!: GPUBuffer;

    // Rasterizer
    rasterizerShaderModule!: GPUShaderModule;
    rasterizerBindGroupLayout!: GPUBindGroupLayout;
    triangleDataBindGroupLayout!: GPUBindGroupLayout;
    rasterizerBindGroup!: GPUBindGroup;

    // Compute pipelines
    clearPipeline!: GPUComputePipeline;
    // Depth
    renderFlatDepthPipeline!: GPUComputePipeline;
    renderGouraudDepthPipeline!: GPUComputePipeline;
    renderTexturedDepthPipeline!: GPUComputePipeline;
    // Color
    renderFlatPipeline!: GPUComputePipeline;
    renderGouraudPipeline!: GPUComputePipeline;
    renderTexturedPipeline!: GPUComputePipeline;
    renderAlphaPipeline!: GPUComputePipeline;

    fullscreenShaderModule!: GPUShaderModule;
    fullscreenPipeline!: GPURenderPipeline;
    fullscreenBindGroup!: GPUBindGroup;

    renderPassDescriptor!: GPURenderPassDescriptor;

    flatTriangleDataBuffer: GPUBuffer | undefined;
    gouraudTriangleDataBuffer: GPUBuffer | undefined;
    texturedTriangleDataBuffer: GPUBuffer | undefined;
    alphaTriangleDataBuffer: GPUBuffer | undefined;

    isRenderingScene: boolean = false;

    triangleCount: number = 0;

    flatTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 8);
    flatTriangleCount: number = 0;

    gouraudTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 10);
    gouraudTriangleCount: number = 0;

    texturedTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 20);
    texturedTriangleCount: number = 0;

    alphaTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 10);
    alphaTriangleCount: number = 0;

    frameCount: number = 0;

    static async init(container: HTMLElement, width: number, height: number): Promise<RendererWebGPU | undefined> {
        const adapter: GPUAdapter | null = await navigator.gpu?.requestAdapter();
        const device: GPUDevice | undefined = await adapter?.requestDevice();
        if (!device) {
            return;
        }
        const canvas: HTMLCanvasElement = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.style.display = 'block';
        canvas.style.position = 'absolute';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        container.appendChild(canvas);

        // @ts-expect-error: For some reason TS doesn't know about GPUCanvasContext
        const context: GPUCanvasContext | null = canvas.getContext('webgpu');
        if (!context) {
            return;
        }
        const presentationFormat: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({
            device,
            format: presentationFormat
        });

        return new RendererWebGPU(canvas, device, context);
    }

    constructor(canvas: HTMLCanvasElement, device: GPUDevice, context: GPUCanvasContext) {
        super(canvas);
        this.device = device;
        this.context = context;
        this.init();
    }

    init(): void {
        const viewportWidth: number = World3D.viewportRight;
        const viewportHeight: number = World3D.viewportBottom;

        this.uniformBuffer = this.device.createBuffer({
            size: 2 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([viewportWidth, viewportHeight]));

        this.pixelBuffer = this.device.createBuffer({
            size: viewportWidth * viewportHeight * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.depthBuffer = this.device.createBuffer({
            size: viewportWidth * viewportHeight * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this.lutsBuffer = this.device.createBuffer({
            size: PALETTE_BYTES + TEXTURES_TRANSLUCENT_BYTES + TEXTURES_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this.updateBrightness();

        this.rasterizerShaderModule = this.device.createShaderModule({
            label: 'rasterizer shaders',
            code: computeRasterizerShaderCode
        });

        this.rasterizerBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'storage'}
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'storage'}
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'read-only-storage'}
                }
            ]
        });

        this.triangleDataBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'read-only-storage'}
                }
            ]
        });

        this.rasterizerBindGroup = this.device.createBindGroup({
            layout: this.rasterizerBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.pixelBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: this.depthBuffer
                    }
                },
                {
                    binding: 2,
                    resource: {
                        buffer: this.lutsBuffer
                    }
                }
            ]
        });

        this.clearPipeline = this.device.createComputePipeline({
            label: 'clear pixels pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'clear'
            }
        });

        // depth
        this.renderFlatDepthPipeline = this.device.createComputePipeline({
            label: 'render flat depth pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout, this.triangleDataBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'renderFlatDepth'
            }
        });
        this.renderGouraudDepthPipeline = this.device.createComputePipeline({
            label: 'render gouraud depth pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout, this.triangleDataBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'renderGouraudDepth'
            }
        });
        this.renderTexturedDepthPipeline = this.device.createComputePipeline({
            label: 'render textured depth pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout, this.triangleDataBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'renderTexturedDepth'
            }
        });

        // color
        this.renderFlatPipeline = this.device.createComputePipeline({
            label: 'render flat pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout, this.triangleDataBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'renderFlat'
            }
        });
        this.renderGouraudPipeline = this.device.createComputePipeline({
            label: 'render gouraud pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout, this.triangleDataBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'renderGouraud'
            }
        });
        this.renderTexturedPipeline = this.device.createComputePipeline({
            label: 'render textured pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout, this.triangleDataBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'renderTextured'
            }
        });
        this.renderAlphaPipeline = this.device.createComputePipeline({
            label: 'render alpha pipeline',
            layout: this.device.createPipelineLayout({bindGroupLayouts: [this.rasterizerBindGroupLayout, this.triangleDataBindGroupLayout]}),
            compute: {
                module: this.rasterizerShaderModule,
                entryPoint: 'renderAlpha'
            }
        });

        this.fullscreenShaderModule = this.device.createShaderModule({
            label: 'fullscreen pixels shaders',
            code: fullscreenPixelsShaderCode
        });

        this.fullscreenPipeline = this.device.createRenderPipeline({
            label: 'fullscreen pixels pipeline',
            layout: 'auto',
            vertex: {
                module: this.fullscreenShaderModule
            },
            fragment: {
                module: this.fullscreenShaderModule,
                targets: [{format: navigator.gpu.getPreferredCanvasFormat()}]
            }
        });

        this.fullscreenBindGroup = this.device.createBindGroup({
            layout: this.fullscreenPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.uniformBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: this.pixelBuffer
                    }
                }
            ]
        });

        this.renderPassDescriptor = {
            label: 'main render pass',
            colorAttachments: [
                {
                    view: this.context.getCurrentTexture().createView(),
                    clearValue: {
                        r: 0.0,
                        g: 0.0,
                        b: 0.0,
                        a: 1.0
                    },
                    loadOp: 'clear',
                    storeOp: 'store'
                }
            ]
        };
    }

    updateBrightness(): void {
        this.updatePalette();
        this.updateTextures();
    }

    updatePalette(): void {
        this.device.queue.writeBuffer(this.lutsBuffer, 0, new Uint32Array(Draw3D.palette));
    }

    updateTextures(): void {
        for (let i: number = 0; i < TEXTURE_COUNT; i++) {
            this.updateTexture(i);
        }
        const texturesTranslucentData: Uint32Array = new Uint32Array(TEXTURES_TRANSLUCENT_BYTES);
        for (let i: number = 0; i < TEXTURE_COUNT; i++) {
            texturesTranslucentData[i] = Draw3D.textureTranslucent[i] ? 1 : 0;
        }
        this.device.queue.writeBuffer(this.lutsBuffer, PALETTE_BYTES, texturesTranslucentData);
    }

    updateTexture(id: number): void {
        const texels: Int32Array | null = Draw3D.getTexels(id);
        if (!texels) {
            return;
        }
        this.device.queue.writeBuffer(this.lutsBuffer, PALETTE_BYTES + TEXTURES_TRANSLUCENT_BYTES + id * TEXTURE_PIXEL_COUNT * 4 * 4, new Uint32Array(texels));
    }

    setBrightness(brightness: number): void {
        this.updateBrightness();
    }

    startRenderScene(): void {
        this.isRenderingScene = true;
        this.triangleCount = 0;
        this.flatTriangleCount = 0;
        this.texturedTriangleCount = 0;
        this.gouraudTriangleCount = 0;
        this.alphaTriangleCount = 0;
    }

    endRenderScene(): void {
        this.isRenderingScene = false;
        this.render();
    }

    render(): void {
        const start: number = performance.now();

        const viewportWidth: number = World3D.viewportRight;
        const viewportHeight: number = World3D.viewportBottom;

        for (const colorAttachment of this.renderPassDescriptor.colorAttachments) {
            colorAttachment!.view = this.context.getCurrentTexture().createView();
        }

        let flatTriangleDataBuffer: GPUBuffer | undefined = this.flatTriangleDataBuffer;
        if (flatTriangleDataBuffer) {
            flatTriangleDataBuffer.destroy();
            this.flatTriangleDataBuffer = undefined;
        }
        let gouraudTriangleDataBuffer: GPUBuffer | undefined = this.gouraudTriangleDataBuffer;
        if (gouraudTriangleDataBuffer) {
            gouraudTriangleDataBuffer.destroy();
            this.gouraudTriangleDataBuffer = undefined;
        }
        let texturedTriangleDataBuffer: GPUBuffer | undefined = this.texturedTriangleDataBuffer;
        if (texturedTriangleDataBuffer) {
            texturedTriangleDataBuffer.destroy();
            this.texturedTriangleDataBuffer = undefined;
        }
        let alphaTriangleDataBuffer: GPUBuffer | undefined = this.alphaTriangleDataBuffer;
        if (alphaTriangleDataBuffer) {
            alphaTriangleDataBuffer.destroy();
            this.alphaTriangleDataBuffer = undefined;
        }

        let flatTriangleDataBindGroup: GPUBindGroup | undefined;
        if (this.flatTriangleCount > 0) {
            flatTriangleDataBuffer = this.device.createBuffer({
                size: this.flatTriangleCount * 8 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
            this.flatTriangleDataBuffer = flatTriangleDataBuffer;
            this.device.queue.writeBuffer(flatTriangleDataBuffer, 0, this.flatTriangleData.subarray(0, this.flatTriangleCount * 8));

            flatTriangleDataBindGroup = this.device.createBindGroup({
                layout: this.triangleDataBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: flatTriangleDataBuffer
                        }
                    }
                ]
            });
        }
        let gouraudTriangleDataBindGroup: GPUBindGroup | undefined;
        if (this.gouraudTriangleCount > 0) {
            gouraudTriangleDataBuffer = this.device.createBuffer({
                size: this.gouraudTriangleCount * 10 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
            this.gouraudTriangleDataBuffer = gouraudTriangleDataBuffer;
            this.device.queue.writeBuffer(gouraudTriangleDataBuffer, 0, this.gouraudTriangleData.subarray(0, this.gouraudTriangleCount * 10));

            gouraudTriangleDataBindGroup = this.device.createBindGroup({
                layout: this.triangleDataBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: gouraudTriangleDataBuffer
                        }
                    }
                ]
            });
        }
        let texturedTriangleDataBindGroup: GPUBindGroup | undefined;
        if (this.texturedTriangleCount > 0) {
            texturedTriangleDataBuffer = this.device.createBuffer({
                size: this.texturedTriangleCount * 20 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
            this.texturedTriangleDataBuffer = texturedTriangleDataBuffer;
            this.device.queue.writeBuffer(this.texturedTriangleDataBuffer, 0, this.texturedTriangleData.subarray(0, this.texturedTriangleCount * 20));

            texturedTriangleDataBindGroup = this.device.createBindGroup({
                layout: this.triangleDataBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: texturedTriangleDataBuffer
                        }
                    }
                ]
            });
        }
        let alphaTriangleDataBindGroup: GPUBindGroup | undefined;
        if (this.alphaTriangleCount > 0) {
            alphaTriangleDataBuffer = this.device.createBuffer({
                size: this.alphaTriangleCount * 10 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
            this.alphaTriangleDataBuffer = alphaTriangleDataBuffer;
            this.device.queue.writeBuffer(alphaTriangleDataBuffer, 0, this.alphaTriangleData.subarray(0, this.alphaTriangleCount * 10));

            alphaTriangleDataBindGroup = this.device.createBindGroup({
                layout: this.triangleDataBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: alphaTriangleDataBuffer
                        }
                    }
                ]
            });
        }

        const encoder: GPUCommandEncoder = this.device.createCommandEncoder({
            label: 'render command encoder'
        });

        const computePass: GPUComputePassEncoder = encoder.beginComputePass();

        computePass.setPipeline(this.clearPipeline);
        computePass.setBindGroup(0, this.rasterizerBindGroup);
        // computePass.setBindGroup(1, callsBindGroup);
        computePass.dispatchWorkgroups(Math.ceil((viewportWidth * viewportHeight) / 256));

        // render depth
        if (this.flatTriangleCount > 0 && flatTriangleDataBindGroup) {
            computePass.setPipeline(this.renderFlatDepthPipeline);
            computePass.setBindGroup(0, this.rasterizerBindGroup);
            computePass.setBindGroup(1, flatTriangleDataBindGroup);
            computePass.dispatchWorkgroups(this.flatTriangleCount);
        }
        if (this.gouraudTriangleCount > 0 && gouraudTriangleDataBindGroup) {
            computePass.setPipeline(this.renderGouraudDepthPipeline);
            computePass.setBindGroup(0, this.rasterizerBindGroup);
            computePass.setBindGroup(1, gouraudTriangleDataBindGroup);
            computePass.dispatchWorkgroups(this.gouraudTriangleCount);
        }
        if (this.texturedTriangleCount > 0 && texturedTriangleDataBindGroup) {
            computePass.setPipeline(this.renderTexturedDepthPipeline);
            computePass.setBindGroup(0, this.rasterizerBindGroup);
            computePass.setBindGroup(1, texturedTriangleDataBindGroup);
            computePass.dispatchWorkgroups(this.texturedTriangleCount);
        }

        // render color
        if (this.flatTriangleCount > 0 && flatTriangleDataBindGroup) {
            computePass.setPipeline(this.renderFlatPipeline);
            computePass.setBindGroup(0, this.rasterizerBindGroup);
            computePass.setBindGroup(1, flatTriangleDataBindGroup);
            computePass.dispatchWorkgroups(this.flatTriangleCount);
        }
        if (this.gouraudTriangleCount > 0 && gouraudTriangleDataBindGroup) {
            computePass.setPipeline(this.renderGouraudPipeline);
            computePass.setBindGroup(0, this.rasterizerBindGroup);
            computePass.setBindGroup(1, gouraudTriangleDataBindGroup);
            computePass.dispatchWorkgroups(this.gouraudTriangleCount);
        }
        if (this.texturedTriangleCount > 0 && texturedTriangleDataBindGroup) {
            computePass.setPipeline(this.renderTexturedPipeline);
            computePass.setBindGroup(0, this.rasterizerBindGroup);
            computePass.setBindGroup(1, texturedTriangleDataBindGroup);
            computePass.dispatchWorkgroups(this.texturedTriangleCount);
        }
        if (this.alphaTriangleCount > 0 && alphaTriangleDataBindGroup) {
            computePass.setPipeline(this.renderAlphaPipeline);
            computePass.setBindGroup(0, this.rasterizerBindGroup);
            computePass.setBindGroup(1, alphaTriangleDataBindGroup);
            computePass.dispatchWorkgroups(1);
        }

        computePass.end();

        const pass: GPURenderPassEncoder = encoder.beginRenderPass(this.renderPassDescriptor);

        pass.setViewport(8, 11, viewportWidth, viewportHeight, 0, 1);

        pass.setPipeline(this.fullscreenPipeline);
        pass.setBindGroup(0, this.fullscreenBindGroup);
        pass.draw(3);

        pass.end();

        const commandBuffer: GPUCommandBuffer = encoder.finish();
        this.device.queue.submit([commandBuffer]);

        const end: number = performance.now();

        if (this.frameCount % 200 === 0) {
            console.log(`Render time: ${end - start}ms`);
        }

        this.frameCount++;
    }

    fillTriangle = (x0: number, x1: number, x2: number, y0: number, y1: number, y2: number, color: number): boolean => {
        if (!this.isRenderingScene) {
            return false;
        }
        if (this.flatTriangleCount >= MAX_TRIANGLES) {
            return !Renderer.cpuRasterEnabled;
        }
        const triangleIndex: number = this.triangleCount++;
        if (Draw3D.alpha !== 0) {
            let offset: number = this.alphaTriangleCount * 10;

            this.alphaTriangleData[offset++] = (1 << 31) | (Draw3D.alpha << 23) | triangleIndex;
            this.alphaTriangleData[offset++] = x0;
            this.alphaTriangleData[offset++] = x1;
            this.alphaTriangleData[offset++] = x2;
            this.alphaTriangleData[offset++] = y0;
            this.alphaTriangleData[offset++] = y1;
            this.alphaTriangleData[offset++] = y2;
            this.alphaTriangleData[offset++] = color;

            this.alphaTriangleCount++;
        } else {
            let offset: number = this.flatTriangleCount * 8;

            this.flatTriangleData[offset++] = triangleIndex;
            this.flatTriangleData[offset++] = x0;
            this.flatTriangleData[offset++] = x1;
            this.flatTriangleData[offset++] = x2;
            this.flatTriangleData[offset++] = y0;
            this.flatTriangleData[offset++] = y1;
            this.flatTriangleData[offset++] = y2;
            this.flatTriangleData[offset++] = color;

            this.flatTriangleCount++;
        }
        return !Renderer.cpuRasterEnabled;
    };

    fillGouraudTriangle = (xA: number, xB: number, xC: number, yA: number, yB: number, yC: number, colorA: number, colorB: number, colorC: number): boolean => {
        if (!this.isRenderingScene) {
            return false;
        }
        if (this.gouraudTriangleCount >= MAX_TRIANGLES) {
            return !Renderer.cpuRasterEnabled;
        }
        const triangleIndex: number = this.triangleCount++;
        if (Draw3D.alpha !== 0) {
            let offset: number = this.alphaTriangleCount * 10;

            this.alphaTriangleData[offset++] = (Draw3D.alpha << 23) | triangleIndex;
            this.alphaTriangleData[offset++] = xA;
            this.alphaTriangleData[offset++] = xB;
            this.alphaTriangleData[offset++] = xC;
            this.alphaTriangleData[offset++] = yA;
            this.alphaTriangleData[offset++] = yB;
            this.alphaTriangleData[offset++] = yC;
            this.alphaTriangleData[offset++] = colorA;
            this.alphaTriangleData[offset++] = colorB;
            this.alphaTriangleData[offset++] = colorC;

            this.alphaTriangleCount++;
        } else {
            let offset: number = this.gouraudTriangleCount * 10;

            this.gouraudTriangleData[offset++] = triangleIndex;
            this.gouraudTriangleData[offset++] = xA;
            this.gouraudTriangleData[offset++] = xB;
            this.gouraudTriangleData[offset++] = xC;
            this.gouraudTriangleData[offset++] = yA;
            this.gouraudTriangleData[offset++] = yB;
            this.gouraudTriangleData[offset++] = yC;
            this.gouraudTriangleData[offset++] = colorA;
            this.gouraudTriangleData[offset++] = colorB;
            this.gouraudTriangleData[offset++] = colorC;

            this.gouraudTriangleCount++;
        }
        return !Renderer.cpuRasterEnabled;
    };

    fillTexturedTriangle = (
        xA: number,
        xB: number,
        xC: number,
        yA: number,
        yB: number,
        yC: number,
        shadeA: number,
        shadeB: number,
        shadeC: number,
        originX: number,
        originY: number,
        originZ: number,
        txB: number,
        txC: number,
        tyB: number,
        tyC: number,
        tzB: number,
        tzC: number,
        texture: number
    ): boolean => {
        if (!this.isRenderingScene) {
            return false;
        }
        if (this.texturedTriangleCount >= MAX_TRIANGLES) {
            return !Renderer.cpuRasterEnabled;
        }
        let offset: number = this.texturedTriangleCount * 20;

        const triangleIndex: number = this.triangleCount++;

        this.texturedTriangleData[offset++] = triangleIndex;
        this.texturedTriangleData[offset++] = xA;
        this.texturedTriangleData[offset++] = xB;
        this.texturedTriangleData[offset++] = xC;
        this.texturedTriangleData[offset++] = yA;
        this.texturedTriangleData[offset++] = yB;
        this.texturedTriangleData[offset++] = yC;
        this.texturedTriangleData[offset++] = shadeA;
        this.texturedTriangleData[offset++] = shadeB;
        this.texturedTriangleData[offset++] = shadeC;
        this.texturedTriangleData[offset++] = originX;
        this.texturedTriangleData[offset++] = originY;
        this.texturedTriangleData[offset++] = originZ;
        this.texturedTriangleData[offset++] = txB;
        this.texturedTriangleData[offset++] = txC;
        this.texturedTriangleData[offset++] = tyB;
        this.texturedTriangleData[offset++] = tyC;
        this.texturedTriangleData[offset++] = tzB;
        this.texturedTriangleData[offset++] = tzC;
        this.texturedTriangleData[offset++] = texture;

        this.texturedTriangleCount++;
        return !Renderer.cpuRasterEnabled;
    };

    destroy(): void {
        this.device.destroy();
    }
}
