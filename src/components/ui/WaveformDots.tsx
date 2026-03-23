import React, { useEffect, useRef } from "react";

const DASH_COUNT = 14;
const DASH_WIDTH = 8;
const DASH_HEIGHT = 4;
const DASH_GAP = 5;
const ANIMATION_SPEED = 0.05;

export const WaveformDots: React.FC<{ isActive: boolean }> = ({ isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const totalWidth = DASH_COUNT * (DASH_WIDTH + DASH_GAP) - DASH_GAP;
    const canvasHeight = 8;
    canvas.width = totalWidth * 2;
    canvas.height = canvasHeight * 2;
    canvas.style.width = `${totalWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    ctx.scale(2, 2);

    const draw = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, totalWidth, canvasHeight);

      for (let i = 0; i < DASH_COUNT; i++) {
        const x = i * (DASH_WIDTH + DASH_GAP);
        const centerY = (canvasHeight - DASH_HEIGHT) / 2;

        const phase = i * 0.35 - timeRef.current;
        const wave = isActive ? Math.sin(phase) * 0.4 + 0.6 : 1;
        const opacity = isActive ? wave : 0.45;

        ctx.beginPath();
        ctx.roundRect(x, centerY, DASH_WIDTH, DASH_HEIGHT, 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.fill();
      }

      if (isActive) {
        timeRef.current += ANIMATION_SPEED;
      }
      animRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [isActive]);

  return <canvas ref={canvasRef} className="block" />;
};
