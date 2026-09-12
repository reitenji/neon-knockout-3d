import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CHASSIS, type Chassis } from '../../../shared/model.js';
import { FIGHTERS } from '../../../shared/fighters.js';
import { createFighterModel, disposeObject } from './FighterModel.js';
import { fighterMotion } from './fighterMotion.js';

export function CharacterPreview({ selected }: Readonly<{ selected: Chassis }>) {
  const container = useRef<HTMLDivElement>(null);
  const selection = useRef(selected);
  useEffect(() => { selection.current = selected; }, [selected]);
  useEffect(() => {
    const parent = container.current;
    if (!parent) return;
    // jsdom can still verify the accessible selection flow without a graphics device.
    if (typeof window.WebGL2RenderingContext === 'undefined') return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { parent.textContent = '3D önizleme için tarayıcıda donanım hızlandırmayı etkinleştir.'; return () => parent.replaceChildren(); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
    parent.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdbedff, 0x253447, 2.4));
    const light = new THREE.DirectionalLight(0xffefd8, 3.3); light.position.set(-100, 200, 250); scene.add(light);
    const rim = new THREE.DirectionalLight(0x6dc6ff, 2); rim.position.set(100, 80, -100); scene.add(rim);
    const camera = new THREE.OrthographicCamera(-240, 240, 115, -35, 1, 1000);
    camera.position.set(0, 170, 450); camera.lookAt(0, 40, 0);
    const models = CHASSIS.map((chassis, i) => {
      const model = createFighterModel(chassis); model.root.position.x = (i - 1.5) * 115;
      model.root.rotation.y = -0.25; scene.add(model.root);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(37, 40, 7, 8), new THREE.MeshStandardMaterial({ color: 0x1e3042, roughness: 0.65, metalness: 0.55 }));
      base.name = `podium-${i}`; base.position.set(model.root.position.x, -4, 0); scene.add(base);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(36, 1, 4, 48), new THREE.MeshBasicMaterial({ color: FIGHTERS[chassis].color }));
      ring.name = `podium-ring-${i}`; ring.rotation.x = -Math.PI / 2; ring.position.set(base.position.x, 0, 0); scene.add(ring);
      return model;
    });
    const resize = (): void => {
      const width = parent.clientWidth; const height = parent.clientHeight;
      renderer.setSize(Math.max(1, width), Math.max(1, height));
      const viewHeight = Math.max(125, 480 * height / Math.max(1, width));
      const viewWidth = viewHeight * width / Math.max(1, height);
      camera.left = -viewWidth / 2; camera.right = viewWidth / 2;
      models.forEach((model, i) => {
        const x = (i - 1.5) * viewWidth / 4;
        model.root.position.x = x;
        scene.getObjectByName(`podium-${i}`)!.position.x = x;
        scene.getObjectByName(`podium-ring-${i}`)!.position.x = x;
      });
      camera.top = viewHeight / 2; camera.bottom = -viewHeight / 2; camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(parent); resize();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let raf = 0;
    const frame = (now: number): void => {
      models.forEach((model, i) => {
        const chassis = CHASSIS[i]!;
        const active = chassis === selection.current;
        const pose = fighterMotion(chassis, 'idle', (now % 1800) / 1800, 0, reducedMotion);
        model.body.position.y = pose.bob;
        model.root.scale.setScalar(active ? 1.08 : 0.87);
        model.root.rotation.y = -0.25 + (active && !reducedMotion ? Math.sin(now / 2000) * 0.2 : 0);
        model.leftArm.rotation.x = -0.2; model.rightArm.rotation.x = -0.2;
        model.leftElbow.rotation.x = -0.35; model.rightElbow.rotation.x = -0.35;
        model.ornaments.rotation.y = chassis === 'PULSE' && !reducedMotion ? now * 0.0004 : 0;
      });
      renderer.render(scene, camera); raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); disposeObject(scene); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); };
  }, []);
  return (
    <div className="fighter-showcase">
      <div ref={container} className="fighter-showcase__canvas" role="img" aria-label="RIFT, BASTION, PULSE ve WRAITH üç boyutlu karakterleri" />
      <p className="fighter-showcase__ability" aria-live="polite">
        <strong style={{ color: FIGHTERS[selected].color }}>{FIGHTERS[selected].role} · {FIGHTERS[selected].abilityName}</strong>
        <span>{FIGHTERS[selected].description} <kbd>Space</kbd></span>
      </p>
    </div>
  );
}
