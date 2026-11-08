// Binary formats for the fast, unreliable channel (the reliable channel carries JSON events).
//   Snapshot (host → player, ~15 Hz): the soldiers near that player (18 bytes each) and every vehicle (33 bytes).
//   Move (player → host, ~20 Hz): his own soldier's state (23 bytes).
// Positions: x, z to 4 cm (×25, ±1310 m), y to 1 cm (×100, ±327 m); angles to ~0.0001 rad (yaw) / 0.7° (pitch).
import type { Stance } from '../game/soldier';

export const STANCES: Stance[] = ['stand', 'crouch', 'prone'];
export const LIFE = ['alive', 'wounded', 'dead'] as const;

export interface SoldierRec {
  nid: number; x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vz: number;
  stance: number; aiming: boolean; sprinting: boolean; underSel: boolean; inVeh: boolean; light: boolean;
  life: number; cur: number; reloadEmpty: boolean; ads: number; /** 0 = not reloading, else progress 0..1. */ reload: number; lean: number;
}
export interface VehicleRec {
  idx: number; x: number; y: number; z: number; q: [number, number, number, number];
  turretYaw: number; gunPitch: number; stYaw: number; stPitch: number; dead: boolean; burning: boolean;
}
export interface Snapshot { t: number; soldiers: SoldierRec[]; vehicles: VehicleRec[] }

const TAU = Math.PI * 2;
const wrapYaw = (a: number) => ((a % TAU) + TAU) % TAU;
const c8 = (v: number) => Math.max(-127, Math.min(127, Math.round(v)));
const c16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v)));

export function encodeSnapshot(t: number, soldiers: SoldierRec[], vehicles: VehicleRec[]): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + 2 + 1 + soldiers.length * 18 + vehicles.length * 33), d = new DataView(buf);
  let o = 0;
  d.setUint8(o, 1); o += 1; d.setFloat32(o, t); o += 4; d.setUint16(o, soldiers.length); o += 2; d.setUint8(o, vehicles.length); o += 1;
  for (const s of soldiers) {
    d.setUint16(o, s.nid); d.setInt16(o + 2, c16(s.x * 25)); d.setInt16(o + 4, c16(s.y * 100)); d.setInt16(o + 6, c16(s.z * 25));
    d.setUint16(o + 8, Math.round(wrapYaw(s.yaw) / TAU * 65535)); d.setInt8(o + 10, c8(s.pitch * 80));
    d.setInt8(o + 11, c8(s.vx * 8)); d.setInt8(o + 12, c8(s.vz * 8));
    d.setUint8(o + 13, s.stance | (s.aiming ? 4 : 0) | (s.sprinting ? 8 : 0) | (s.underSel ? 16 : 0) | (s.inVeh ? 32 : 0) | (s.light ? 64 : 0));
    d.setUint8(o + 14, s.life | (Math.min(7, s.cur) << 2) | (s.reloadEmpty ? 32 : 0));
    d.setUint8(o + 15, Math.round(s.ads * 255)); d.setUint8(o + 16, s.reload > 0 ? 1 + Math.round(Math.min(1, s.reload) * 254) : 0);
    d.setInt8(o + 17, c8(s.lean * 100));
    o += 18;
  }
  for (const v of vehicles) {
    d.setUint8(o, v.idx); d.setFloat32(o + 1, v.x); d.setFloat32(o + 5, v.y); d.setFloat32(o + 9, v.z);
    for (let k = 0; k < 4; k++) d.setInt16(o + 13 + k * 2, c16(v.q[k] * 32767));
    d.setInt16(o + 21, c16(v.turretYaw * 10000)); d.setInt16(o + 23, c16(v.gunPitch * 20000)); d.setInt16(o + 25, c16(v.stYaw * 10000)); d.setInt16(o + 27, c16(v.stPitch * 20000));
    d.setUint8(o + 29, (v.dead ? 1 : 0) | (v.burning ? 2 : 0));
    o += 33;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot | null {
  const d = new DataView(buf);
  if (buf.byteLength < 8 || d.getUint8(0) !== 1) return null;
  const t = d.getFloat32(1), ns = d.getUint16(5), nv = d.getUint8(7);
  if (buf.byteLength < 8 + ns * 18 + nv * 33) return null;
  let o = 8;
  const soldiers: SoldierRec[] = [], vehicles: VehicleRec[] = [];
  for (let i = 0; i < ns; i++, o += 18) {
    const f = d.getUint8(o + 13), g = d.getUint8(o + 14), r = d.getUint8(o + 16);
    soldiers.push({
      nid: d.getUint16(o), x: d.getInt16(o + 2) / 25, y: d.getInt16(o + 4) / 100, z: d.getInt16(o + 6) / 25,
      yaw: d.getUint16(o + 8) / 65535 * TAU, pitch: d.getInt8(o + 10) / 80, vx: d.getInt8(o + 11) / 8, vz: d.getInt8(o + 12) / 8,
      stance: f & 3, aiming: !!(f & 4), sprinting: !!(f & 8), underSel: !!(f & 16), inVeh: !!(f & 32), light: !!(f & 64),
      life: g & 3, cur: (g >> 2) & 7, reloadEmpty: !!(g & 32), ads: d.getUint8(o + 15) / 255, reload: r ? (r - 1) / 254 : 0, lean: d.getInt8(o + 17) / 100,
    });
  }
  for (let i = 0; i < nv; i++, o += 33) {
    vehicles.push({
      idx: d.getUint8(o), x: d.getFloat32(o + 1), y: d.getFloat32(o + 5), z: d.getFloat32(o + 9),
      q: [d.getInt16(o + 13) / 32767, d.getInt16(o + 15) / 32767, d.getInt16(o + 17) / 32767, d.getInt16(o + 19) / 32767],
      turretYaw: d.getInt16(o + 21) / 10000, gunPitch: d.getInt16(o + 23) / 20000, stYaw: d.getInt16(o + 25) / 10000, stPitch: d.getInt16(o + 27) / 20000,
      dead: !!(d.getUint8(o + 29) & 1), burning: !!(d.getUint8(o + 29) & 2),
    });
  }
  return { t, soldiers, vehicles };
}

export interface MoveRec { x: number; y: number; z: number; vx: number; vz: number; yaw: number; pitch: number; stance: number; aiming: boolean; sprinting: boolean; underSel: boolean; light: boolean; cur: number; ads: number; lean: number }

export function encodeMove(m: MoveRec): ArrayBuffer {
  const buf = new ArrayBuffer(23), d = new DataView(buf);
  d.setUint8(0, 2); d.setFloat32(1, m.x); d.setFloat32(5, m.y); d.setFloat32(9, m.z);
  d.setInt8(13, c8(m.vx * 8)); d.setInt8(14, c8(m.vz * 8));
  d.setUint16(15, Math.round(wrapYaw(m.yaw) / TAU * 65535)); d.setInt16(17, c16(m.pitch * 20000));
  d.setUint8(19, m.stance | (m.aiming ? 4 : 0) | (m.sprinting ? 8 : 0) | (m.underSel ? 16 : 0) | (m.light ? 32 : 0));
  d.setUint8(20, Math.min(7, m.cur)); d.setUint8(21, Math.round(m.ads * 255)); d.setInt8(22, c8(m.lean * 100));
  return buf;
}
export function decodeMove(buf: ArrayBuffer): MoveRec | null {
  if (buf.byteLength !== 23) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== 2) return null;
  const f = d.getUint8(19);
  return {
    x: d.getFloat32(1), y: d.getFloat32(5), z: d.getFloat32(9), vx: d.getInt8(13) / 8, vz: d.getInt8(14) / 8,
    yaw: d.getUint16(15) / 65535 * TAU, pitch: d.getInt16(17) / 20000,
    stance: f & 3, aiming: !!(f & 4), sprinting: !!(f & 8), underSel: !!(f & 16), light: !!(f & 32),
    cur: d.getUint8(20), ads: d.getUint8(21) / 255, lean: d.getInt8(22) / 100,
  };
}
