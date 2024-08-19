export abstract class Renderer {
    static renderer: Renderer | undefined;

    static cpuRasterEnabled: boolean = true;

    constructor(readonly canvas: HTMLCanvasElement) {}

    static resetRenderer(): void {
        if (Renderer.renderer) {
            Renderer.renderer.destroy();
            Renderer.renderer.canvas.remove();
            Renderer.renderer = undefined;
        }
    }

    static resize(width: number, height: number): void {
        if (Renderer.renderer) {
            Renderer.renderer.resize(width, height);
        }
    }

    static updateTexture(id: number): void {
        if (Renderer.renderer) {
            Renderer.renderer.updateTexture(id);
        }
    }

    static setBrightness(brightness: number): void {
        if (Renderer.renderer) {
            Renderer.renderer.setBrightness(brightness);
        }
    }

    static startRenderScene(): void {
        if (Renderer.renderer) {
            Renderer.renderer.startRenderScene();
        }
    }

    static endRenderScene(): void {
        if (Renderer.renderer) {
            Renderer.renderer.endRenderScene();
        }
    }

    static fillTriangle = (x0: number, x1: number, x2: number, y0: number, y1: number, y2: number, color: number): boolean => {
        if (Renderer.renderer) {
            return Renderer.renderer.fillTriangle(x0, x1, x2, y0, y1, y2, color);
        }
        return false;
    };

    static fillGouraudTriangle = (xA: number, xB: number, xC: number, yA: number, yB: number, yC: number, colorA: number, colorB: number, colorC: number): boolean => {
        if (Renderer.renderer) {
            return Renderer.renderer.fillGouraudTriangle(xA, xB, xC, yA, yB, yC, colorA, colorB, colorC);
        }
        return false;
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
    ): boolean => {
        if (Renderer.renderer) {
            return Renderer.renderer.fillTexturedTriangle(xA, xB, xC, yA, yB, yC, shadeA, shadeB, shadeC, originX, originY, originZ, txB, txC, tyB, tyC, tzB, tzC, texture);
        }
        return false;
    };

    resize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    abstract updateTexture(id: number): void;

    abstract setBrightness(brightness: number): void;

    abstract startRenderScene(): void;

    abstract endRenderScene(): void;

    abstract fillTriangle(x0: number, x1: number, x2: number, y0: number, y1: number, y2: number, color: number): boolean;

    abstract fillGouraudTriangle(xA: number, xB: number, xC: number, yA: number, yB: number, yC: number, colorA: number, colorB: number, colorC: number): boolean;

    abstract fillTexturedTriangle(
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
    ): boolean;

    abstract destroy(): void;
}
