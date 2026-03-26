import React, { useEffect, useRef } from "react";

const DASH_COUNT = 14;
const DASH_WIDTH = 8;
const DASH_HEIGHT = 4;
const DASH_GAP = 5;
const ANIMATION_SPEED = 0.05;

export const WaveformDots: React.FC<{ isActive: boolean; getVolume?: () => number }> = ({ isActive, getVolume }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);
  const smoothedVolumeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const totalWidth = 177; // Roughly 14 bars * 13 width
    const canvasHeight = 24; 
    canvas.width = totalWidth * 2;
    canvas.height = canvasHeight * 2;
    canvas.style.width = `${totalWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    ctx.scale(2, 2);

    const draw = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, totalWidth, canvasHeight);
      
      // Calculate smoothed volume
      if (isActive && getVolume) {
        // High sensitivity multiplier
        const rawVol = Math.min(1, getVolume() * 9.0);
        // Slightly faster response for snappier peaks
        smoothedVolumeRef.current += (rawVol - smoothedVolumeRef.current) * 0.22;
      } else {
        smoothedVolumeRef.current += (0 - smoothedVolumeRef.current) * 0.12;
      }

      // The animation state base variables
      // Vertical center offset (lower value = lower position)
      const centerY = (canvasHeight / 2) - 2;
      const amplitudeLimit = canvasHeight / 2 - 2; 
      const idleBase = isActive ? 0.14 : 0;
      const audioReact = Math.max(smoothedVolumeRef.current, idleBase);

      // Helper to draw a single fluid ribbon
      const drawFluid = (amplitudeMultiplier: number, frequency: number, speed: number, color: string, thicknessMod = 1.0) => {
        ctx.beginPath();
        ctx.moveTo(0, centerY);

        // Top edge
        for (let x = 0; x <= totalWidth; x += 1.5) {
          const nx = x / totalWidth;
          const envelope = Math.pow(Math.sin(nx * Math.PI), 1.6); // Slightly sharper taper
          
          const phase1 = timeRef.current * speed + nx * Math.PI * frequency;
          const phase2 = timeRef.current * (speed * 0.7) - nx * Math.PI * (frequency * 0.6);
          const wave = (Math.sin(phase1) + Math.cos(phase2)) * 0.5;
          const y = wave * (audioReact * amplitudeLimit * amplitudeMultiplier) * envelope;
          
          ctx.lineTo(x, centerY + y);
        }

        // Bottom edge (return trip, slight phase shift to create thickness)
        for (let x = totalWidth; x >= 0; x -= 1.5) {
          const nx = x / totalWidth;
          const envelope = Math.pow(Math.sin(nx * Math.PI), 1.6);
          
          const phase1 = timeRef.current * speed + nx * Math.PI * frequency;
          const phase2 = timeRef.current * (speed * 0.7) - nx * Math.PI * (frequency * 0.6) + Math.PI * 0.3;
          const wave = (Math.sin(phase1) + Math.cos(phase2)) * 0.5;
          
          const y = wave * (audioReact * amplitudeLimit * amplitudeMultiplier) * envelope;
          // Increased baseline thickness boost for "trippier" presence
          const thickness = audioReact * 3.2 * thicknessMod * envelope;
          ctx.lineTo(x, centerY - y - thickness);
        }

        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };

      // Draw four overlaid ribbons for a more complex "trippy" feel
      // Background (deepest, slowest) - added a touch of blue/cyan tint for depth
      drawFluid(1.0, 1.5, 0.04, "rgba(255, 255, 255, 0.12)", 0.8);
      // Middle 1
      drawFluid(0.8, 2.5, -0.06, "rgba(230, 240, 255, 0.20)", 1.0);
      // Middle 2 (High frequency ripple)
      drawFluid(0.6, 5.0, 0.12, "rgba(255, 255, 255, 0.30)", 0.5);
      // Foreground (sharpest, most reactive)
      drawFluid(0.4, 3.5, -0.08, "rgba(255, 255, 255, 0.55)", 1.2);

      if (isActive || smoothedVolumeRef.current > 0.01) {
        timeRef.current += 1;
      }
      
      animRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [isActive, getVolume]);

  return <canvas ref={canvasRef} className="block" />;
};
