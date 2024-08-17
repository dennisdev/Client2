import Draw3D from '../graphics/Draw3D';
import {SHADER_CODE as computeRasterizerShaderCode} from './compute-rasterizer.wgsl';
import {SHADER_CODE as fullscreenPixelsShaderCode} from './fullscreen-pixels.wgsl';

const MAX_TRIANGLES: number = 100000;

const TEXTURE_COUNT: number = 50;

const TEXTURE_SIZE: number = 128;
const TEXTURE_PIXEL_COUNT: number = TEXTURE_SIZE * TEXTURE_SIZE;

const PALETTE_BYTES: number = 65536 * 4;
const TEXTURES_TRANSLUCENT_BYTES: number = TEXTURE_COUNT * 4;
const TEXTURES_BYTES: number = TEXTURE_COUNT * TEXTURE_PIXEL_COUNT * 4 * 4;

export class Renderer {
    static device: GPUDevice | undefined;

    static lutsBuffer: GPUBuffer;

    static texturedTriangleDataBuffer: GPUBuffer | undefined;
    static gouraudTriangleDataBuffer: GPUBuffer | undefined;

    static triangleCount: number = 0;

    static texturedTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 19);
    static texturedTriangleCount: number = 0;

    static gouraudTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 9);
    static gouraudTriangleCount: number = 0;

    static frameCount: number = 0;

    static render: () => void;

    static async init(): Promise<void> {
        const adapter: GPUAdapter | null = await navigator.gpu?.requestAdapter();
        const device: GPUDevice | undefined = await adapter?.requestDevice();
        if (!device) {
            return;
        }

        Renderer.device = device;

        // Get a WebGPU context from the canvas and configure it
        const canvas: HTMLCanvasElement = document.getElementById('canvas-webgpu') as HTMLCanvasElement;
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

        const uniformBuffer: GPUBuffer = device.createBuffer({
            size: 2 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([canvas.width, canvas.height]));

        const pixelBuffer: GPUBuffer = device.createBuffer({
            size: canvas.width * canvas.height * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        const lutsBuffer: GPUBuffer = device.createBuffer({
            size: PALETTE_BYTES + TEXTURES_TRANSLUCENT_BYTES + TEXTURES_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        Renderer.lutsBuffer = lutsBuffer;

        Renderer.updateBrightness();

        const rasterizerShaderModule: GPUShaderModule = device.createShaderModule({
            label: 'rasterizer shaders',
            code: computeRasterizerShaderCode
        });

        const rasterizerBindGroupLayout: GPUBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'storage'}
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'read-only-storage'}
                }
            ]
        });

        const triangleDataBindGroupLayout: GPUBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'read-only-storage'}
                }
            ]
        });

        const rasterizerBindGroup: GPUBindGroup = device.createBindGroup({
            layout: rasterizerBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: pixelBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: lutsBuffer
                    }
                }
            ]
        });

        const clearPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'clear pixels pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'clear'
            }
        });

        const renderTexturedPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'compute render pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'render'
            }
        });
        const renderGouraudPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'compute render pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderGouraud'
            }
        });

        const fullscreenShaderModule: GPUShaderModule = device.createShaderModule({
            label: 'fullscreen pixels shaders',
            code: fullscreenPixelsShaderCode
        });

        const fullscreenPipeline: GPURenderPipeline = device.createRenderPipeline({
            label: 'fullscreen pixels pipeline',
            layout: 'auto',
            vertex: {
                module: fullscreenShaderModule
            },
            fragment: {
                module: fullscreenShaderModule,
                targets: [{format: presentationFormat}]
            }
        });

        const fullscreenBindGroup: GPUBindGroup = device.createBindGroup({
            layout: fullscreenPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: uniformBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: pixelBuffer
                    }
                }
            ]
        });

        const renderPassDescriptor: GPURenderPassDescriptor = {
            label: 'main render pass',
            colorAttachments: [
                {
                    view: context.getCurrentTexture().createView(),
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

        function render(): void {
            if (!device) {
                return;
            }

            const start: number = performance.now();

            for (const colorAttachment of renderPassDescriptor.colorAttachments) {
                colorAttachment!.view = context!.getCurrentTexture().createView();
            }

            let texturedTriangleDataBuffer: GPUBuffer | undefined = Renderer.texturedTriangleDataBuffer;
            if (texturedTriangleDataBuffer) {
                texturedTriangleDataBuffer.destroy();
                Renderer.texturedTriangleDataBuffer = undefined;
            }
            let gouraudTriangleDataBuffer: GPUBuffer | undefined = Renderer.gouraudTriangleDataBuffer;
            if (gouraudTriangleDataBuffer) {
                gouraudTriangleDataBuffer.destroy();
                Renderer.gouraudTriangleDataBuffer = undefined;
            }

            const encoder: GPUCommandEncoder = device.createCommandEncoder({
                label: 'render command encoder'
            });

            const computePass: GPUComputePassEncoder = encoder.beginComputePass();

            computePass.setPipeline(clearPipeline);
            computePass.setBindGroup(0, rasterizerBindGroup);
            // computePass.setBindGroup(1, callsBindGroup);
            computePass.dispatchWorkgroups(Math.ceil((canvas.width * canvas.height) / 256));

            if (Renderer.texturedTriangleCount > 0) {
                texturedTriangleDataBuffer = device.createBuffer({
                    size: Renderer.texturedTriangleCount * 19 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                });
                Renderer.texturedTriangleDataBuffer = texturedTriangleDataBuffer;
                device.queue.writeBuffer(texturedTriangleDataBuffer, 0, Renderer.texturedTriangleData.subarray(0, Renderer.texturedTriangleCount * 19));

                const triangleDataBindGroup: GPUBindGroup = device.createBindGroup({
                    layout: triangleDataBindGroupLayout,
                    entries: [
                        {
                            binding: 0,
                            resource: {
                                buffer: texturedTriangleDataBuffer
                            }
                        }
                    ]
                });

                computePass.setPipeline(renderTexturedPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, triangleDataBindGroup);
                // computePass.dispatchWorkgroups(1);
                computePass.dispatchWorkgroups(Renderer.texturedTriangleCount);
            }

            if (Renderer.gouraudTriangleCount > 0) {
                gouraudTriangleDataBuffer = device.createBuffer({
                    size: Renderer.gouraudTriangleCount * 9 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                });
                Renderer.gouraudTriangleDataBuffer = gouraudTriangleDataBuffer;
                device.queue.writeBuffer(gouraudTriangleDataBuffer, 0, Renderer.gouraudTriangleData.subarray(0, Renderer.gouraudTriangleCount * 9));

                const triangleDataBindGroup: GPUBindGroup = device.createBindGroup({
                    layout: triangleDataBindGroupLayout,
                    entries: [
                        {
                            binding: 0,
                            resource: {
                                buffer: gouraudTriangleDataBuffer
                            }
                        }
                    ]
                });

                computePass.setPipeline(renderGouraudPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, triangleDataBindGroup);
                // computePass.dispatchWorkgroups(1);
                computePass.dispatchWorkgroups(Renderer.gouraudTriangleCount);
            }

            computePass.end();

            const pass: GPURenderPassEncoder = encoder.beginRenderPass(renderPassDescriptor);

            pass.setPipeline(fullscreenPipeline);
            pass.setBindGroup(0, fullscreenBindGroup);
            pass.draw(3);

            pass.end();

            const commandBuffer: GPUCommandBuffer = encoder.finish();
            device.queue.submit([commandBuffer]);

            const end: number = performance.now();

            if (Renderer.frameCount % 200 === 0) {
                console.log(`Render time: ${end - start}ms`);
            }

            Renderer.frameCount++;
        }

        // const start = performance.now();
        render();
        // const end = performance.now();

        // console.log(`Render time: ${end - start}ms`);

        Renderer.render = render;
    }

    static updateBrightness(): void {
        const device: GPUDevice | undefined = Renderer.device;
        if (!device) {
            return;
        }

        // Update palette
        device.queue.writeBuffer(Renderer.lutsBuffer, 0, new Uint32Array(Draw3D.palette));

        Renderer.updateTextures();
    }

    static updateTextures(): void {
        const device: GPUDevice | undefined = Renderer.device;
        if (!device) {
            return;
        }

        for (let i: number = 0; i < TEXTURE_COUNT; i++) {
            Renderer.updateTexture(i);
        }
        const texturesTranslucentData: Uint32Array = new Uint32Array(TEXTURES_TRANSLUCENT_BYTES);
        for (let i: number = 0; i < TEXTURE_COUNT; i++) {
            texturesTranslucentData[i] = Draw3D.textureTranslucent[i] ? 1 : 0;
        }
        device.queue.writeBuffer(Renderer.lutsBuffer, PALETTE_BYTES, texturesTranslucentData);
    }

    static updateTexture(id: number): void {
        const device: GPUDevice | undefined = Renderer.device;
        if (!device) {
            return;
        }

        const texels: Int32Array | null = Draw3D.getTexels(id);
        if (!texels) {
            return;
        }
        device.queue.writeBuffer(Renderer.lutsBuffer, PALETTE_BYTES + TEXTURES_TRANSLUCENT_BYTES + id * TEXTURE_PIXEL_COUNT * 4 * 4, new Uint32Array(texels));
    }

    static setBrightness(brightness: number): void {
        Renderer.updateBrightness();
    }

    static startRenderScene(): void {
        Renderer.triangleCount = 0;
        Renderer.texturedTriangleCount = 0;
        Renderer.gouraudTriangleCount = 0;
    }

    static fillGouraudTriangle = (xA: number, xB: number, xC: number, yA: number, yB: number, yC: number, colorA: number, colorB: number, colorC: number): void => {
        if (Renderer.gouraudTriangleCount >= MAX_TRIANGLES) {
            return;
        }
        const offset: number = Renderer.gouraudTriangleCount * 9;

        Renderer.gouraudTriangleData[offset] = xA;
        Renderer.gouraudTriangleData[offset + 1] = xB;
        Renderer.gouraudTriangleData[offset + 2] = xC;
        Renderer.gouraudTriangleData[offset + 3] = yA;
        Renderer.gouraudTriangleData[offset + 4] = yB;
        Renderer.gouraudTriangleData[offset + 5] = yC;
        Renderer.gouraudTriangleData[offset + 6] = colorA;
        Renderer.gouraudTriangleData[offset + 7] = colorB;
        Renderer.gouraudTriangleData[offset + 8] = colorC;

        Renderer.gouraudTriangleCount++;
    };

    static fillTexturedTriangle = (
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
    ): void => {
        if (Renderer.texturedTriangleCount >= MAX_TRIANGLES) {
            return;
        }
        const offset: number = Renderer.texturedTriangleCount * 19;

        Renderer.texturedTriangleData[offset] = xA;
        Renderer.texturedTriangleData[offset + 1] = xB;
        Renderer.texturedTriangleData[offset + 2] = xC;
        Renderer.texturedTriangleData[offset + 3] = yA;
        Renderer.texturedTriangleData[offset + 4] = yB;
        Renderer.texturedTriangleData[offset + 5] = yC;
        Renderer.texturedTriangleData[offset + 6] = shadeA;
        Renderer.texturedTriangleData[offset + 7] = shadeB;
        Renderer.texturedTriangleData[offset + 8] = shadeC;
        Renderer.texturedTriangleData[offset + 9] = originX;
        Renderer.texturedTriangleData[offset + 10] = originY;
        Renderer.texturedTriangleData[offset + 11] = originZ;
        Renderer.texturedTriangleData[offset + 12] = txB;
        Renderer.texturedTriangleData[offset + 13] = txC;
        Renderer.texturedTriangleData[offset + 14] = tyB;
        Renderer.texturedTriangleData[offset + 15] = tyC;
        Renderer.texturedTriangleData[offset + 16] = tzB;
        Renderer.texturedTriangleData[offset + 17] = tzC;
        Renderer.texturedTriangleData[offset + 18] = texture;

        Renderer.texturedTriangleCount++;
    };
}
