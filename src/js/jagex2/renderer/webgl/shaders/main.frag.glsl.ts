import {hslToRgbFunction} from './commons.glsl';

export const SHADER_CODE: string = `
#version 300 es

precision highp float;

in vec2 v_texCoord;
in vec3 v_barycentric;

out vec4 fragColor;

const vec2 vertices[3] = vec2[3](
    vec2(20, 200),
    vec2(400, 200),
    vec2(200, 20)
);

const int colors[3] = int[3](
    127,
    127,
    127
);

const float brightness = 0.9;


const float width = 512.0;
const float height = 334.0;

const int boundBottom = int(height);

${hslToRgbFunction}

int reciprocal15(int value) {
    return 32768 / value;
}

vec3 getScanlineColor(int xA, int xB, int colorA, int colorB) {
    int colorStep;
    int length;
    if (xA < xB) {
        length = (xB - xA) >> 2;
        if (length > 0) {
            colorStep = (colorB - colorA) * reciprocal15(length) >> 15;
        }
    } else {
        return vec3(1.0, 0.0, 1.0); 
    }
    int scanlineX = int(gl_FragCoord.x) - xA;
    colorA += colorStep * (scanlineX >> 2);
    return hslToRgb(colorA >> 8, brightness);
}

void main() {
    float x = v_barycentric.x * vertices[0].x + v_barycentric.y * vertices[1].x + v_barycentric.z * vertices[2].x;
    float y = float(gl_FragCoord.y);
    fragColor = vec4(1.0, 0.0, 0.0, 1.0);
    // fragColor.r = x / 512.0;
    // fragColor.r = y / 255.0;
    int xA = int(vertices[0].x);
    int xB = int(vertices[1].x);
    int xC = int(vertices[2].x);
    int yA = int(vertices[0].y);
    int yB = int(vertices[1].y);
    int yC = int(vertices[2].y);
    int colorA = colors[0];
    int colorB = colors[1];
    int colorC = colors[2];

    int scanlineY = int(height - gl_FragCoord.y - 1.0) - min(yA, min(yB, yC));
    // fragColor.r = float(scanlineY) / 255.0;

    int dxAB = xB - xA;
	int dyAB = yB - yA;
	int dxAC = xC - xA;
	int dyAC = yC - yA;

	int xStepAB = 0;
	int colorStepAB = 0;
	if (yB != yA) {
		xStepAB = (dxAB << 16) / dyAB;
        colorStepAB = ((colorB - colorA) << 15) / dyAB;
	}

	int xStepBC = 0;
	int colorStepBC = 0;
	if (yC != yB) {
        xStepBC = ((xC - xB) << 16) / (yC - yB);
        colorStepBC = ((colorC - colorB) << 15) / (yC - yB);
	}

	int xStepAC = 0;
	int colorStepAC = 0;
	if (yC != yA) {
        xStepAC = ((xA - xC) << 16) / (yA - yC);
        colorStepAC = ((colorA - colorC) << 15) / (yA - yC);
	}
	if (yA <= yB && yA <= yC) {
        if (yB < yC) {
			xC = xA <<= 16;
			colorC = colorA <<= 15;
			if (yA < 0) {
				xC -= xStepAC * yA;
				xA -= xStepAB * yA;
				colorC -= colorStepAC * yA;
				colorA -= colorStepAB * yA;
				yA = 0;
			}

			xB <<= 16;
			colorB <<= 15;
			if (yB < 0) {
				xB -= xStepBC * yB;
				colorB -= colorStepBC * yB;
				yB = 0;
			}

			if (yA != yB && xStepAC < xStepAB || yA == yB && xStepAC > xStepBC) {
                // fragColor.b = 1.0;
            } else {
                // fragColor.g = 1.0;
            }
        } else {
            // fragColor.g = 1.0;
        }
	} else if (yB <= yC) {
        // fragColor.g = 1.0;
    } else if (yC < boundBottom) {
     	if (yA > boundBottom) {
			yA = boundBottom;
		}

		if (yB > boundBottom) {
			yB = boundBottom;
		}

		if (yA < yB) {

        } else {
			xA = xC <<= 16;
			colorA = colorC <<= 15;
			if (yC < 0) {
				xA -= xStepBC * yC;
				xC -= xStepAC * yC;
				colorA -= colorStepBC * yC;
				colorC -= colorStepAC * yC;
				yC = 0;
			}

			xB <<= 16;
			colorB <<= 15;
			if (yB < 0) {
				xB -= xStepAB * yB;
				colorB -= colorStepAB * yB;
				yB = 0;
			}

			if (xStepBC < xStepAC) {

            } else {
				yA -= yB;
				yB -= yC;

                int currentScanline = 0;
					
                while (--yB >= 0) {
                    if (currentScanline == scanlineY) {
                        fragColor.rgb = hslToRgb(colorC >> 7 >> 8, brightness);
                        fragColor.rgb = getScanlineColor(xC >> 16, xA >> 16, colorC >> 7, colorA >> 7);
                    }
					// gouraudRaster(xC >> 16, xA >> 16, colorC >> 7, colorA >> 7, data, yC, 0);
					xA += xStepBC;
					xC += xStepAC;
					colorA += colorStepBC;
					colorC += colorStepAC;
					// yC += width2d;
                    currentScanline++;
				}
				while (--yA >= 0) {
                    if (currentScanline == scanlineY) {
                        fragColor.rgb = hslToRgb(colorC >> 7 >> 8, brightness);
                        fragColor.rgb = getScanlineColor(xC >> 16, xB >> 16, colorC >> 7, colorB >> 7);
                    }
					// gouraudRaster(xC >> 16, xB >> 16, colorC >> 7, colorB >> 7, data, yC, 0);
					xB += xStepAB;
					xC += xStepAC;
					colorB += colorStepAB;
					colorC += colorStepAC;
					// yC += width2d;
                    currentScanline++;
				}

            }
        }
    }
        
    fragColor = vec4(1.0, 0.0, 0.0, 1.0);
}

`.trim();
