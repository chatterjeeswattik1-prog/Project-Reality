# Project Reality (PR:BF2) Insurgency: Design Reference

Scope: the modern **Insurgency** game mode only, with two factions: **Insurgents** (Iraq, 2003-2011) and **US forces** (US Army, plus USMC where it differs). This is a reference for building a Three.js browser clone.

**Confidence tags**
- **[M]**: from the official PR manual (realitymod.org/manual) or PR data files (the map-gallery JSON and the localisation repo). Treat these as authoritative for PR v1.x.
- **[~]**: approximate, from community knowledge or memory. Use these as tuning defaults, not facts.
- **[R]**: real-world data (manufacturer or military figures).

Sources are listed at the end.

---

## 1. Insurgency game mode rules

### 1.1 Overview
| Item | Value |
|---|---|
| Teams | BLUFOR "Coalition" (US Army / USMC) vs OPFOR "Insurgents". Civilians are not a separate team: they are Insurgent players using the unarmed Civilian kit. [M] |
| BLUFOR objective | Find and destroy the insurgents' weapon caches before BLUFOR runs out of tickets or time. [M] |
| Insurgent objective | Keep enough caches alive (manual: "protect at least two caches") until the Coalition's last ticket is gone. [M] |
| Insurgent tickets | Effectively unlimited respawns. In the map data, the insurgent "ticket" value is a small number (3-5) that appears to equal the number of caches the Coalition must destroy. [M data / ~ interpretation] |
| BLUFOR tickets (64-player layers, from map data) | Fallujah West (USMC) **550**; Karbala 128 (US Army) **500**; Ramiel (US Army) **650**; Kokan (US Army) **550**; Korengal (US Army) **650**; Al Basrah (British) **650**. Small layers (16 players) use about 450. [M data] |
| Caches per map | Manual: "most maps have six caches, five must be destroyed" (varies by map and layer). Map data: 3-5 required. **Clone default: 6 cache sites spawned in sequence, 5 to win (or 4 on a mid-size map).** [M] |
| Ticket reward for destroying a cache | **+30 BLUFOR tickets** per cache in the current manual. v0.9 used +25 and older builds +10. [M] |
| Round length | The server time limit is often 4 h, but real rounds usually last **60-120 min** (approximate). |

### 1.2 Weapon caches [M]
- **Up to 2 caches are active at once.** When one is destroyed, the next one in the sequence becomes active.
- Caches appear on the Insurgents' map 30 s before the round starts. Insurgents always know where their caches are.
- **Only C4 destroys a cache** (small or large C4 packs). Other weapons do no damage or only light damage. Insurgents can repair a cache with shovels or wrenches, and Insurgent Engineers can repair them too.
- When a cache is destroyed, every player is told how many remain ("Weapon Cache destroyed! [n of total]").
- A cache that has not been revealed acts as a spawn point for Insurgents. Like a FOB, it is disabled when enemies come close (see 2.6).
- Map marker states:
  - *Unknown Insurgent Cache*: visible only to Insurgents.
  - *Known Insurgent Cache*: shown to Insurgents once the Coalition has located it.
  - *Known Coalition Cache*: shown to BLUFOR as an approximate marker, offset **up to 75 m** from the true position.
- **Destroying a friendly cache adds a 300 s respawn penalty** to the Insurgents responsible.

### 1.3 Intelligence points (IP) [M]
| Event | IP |
|---|---|
| Insurgent killed (by the Coalition, within 300 m of an active cache) | **+1** |
| Civilian or insurgent arrested (zip-ties, buckshot, or a knife kill on an insurgent) | **+10** |
| Civilian shot inside the ROE (a legitimate target) | +10 (civilian page) |
| Civilian killed in violation of the ROE | **-5** (game-modes page) / -10 (civilian page). **Use -10.** |
| Destroying an unused civilian vehicle | -5 |
| Destroying a vehicle with a civilian within 50 m in the last 60 s | -50 |
| Kills from jets, tanks or attack helicopters | 0 |

- **50 IP reveals one cache** to BLUFOR, with a 75 m offset. The cache's marker appears and the Insurgents are warned "The enemy have obtained information about a Weapon Cache!"
- IP is clamped to the range **-50 to +50**.
- If the server has fewer than 32 players, the threshold is **halved to 25 IP**.
- The first cache location is typically revealed about **5 min** into the round. Revealed caches spawn with a 5-minute grace period.

### 1.4 Insurgent spawning
| Spawn | Rules |
|---|---|
| Insurgent HQ / main | This is the insurgent main base (e.g. "Mosque" on Al Basrah and Karbala). It is always available and is an out-of-bounds zone for BLUFOR (a restricted combat-area polygon, about 190 x 140 m on Al Basrah). [M data] |
| Hideouts | Built by the Cell Leader with no supply cost. Limits: **max 6 per team**, **more than 200 m** from other hideouts and the HQ, and at least 10 m from the map edge. **Spawning is disabled while 2 or more enemies are within 50 m**, and stays disabled until 90 s after they leave or die. A hideout comes online 90 s after it is built. [M] |
| Unrevealed caches | Act as spawn points. They use the same proximity disable as FOBs. [M] |
| Squad rally point | The Cell Leader can place one, with the same rules as BLUFOR (see 2.6). [M] |
| Mortar | Insurgents get a mortar barrage every 20 min via "NEED AREA ATTACK". [M] |

### 1.5 BLUFOR tickets and how they are lost
| Event | Ticket cost |
|---|---|
| Soldier death (when the player respawns or gives up; a revive costs nothing) | **1** (approximate; this is the standard PR / AAS rule) |
| Jeep or truck (HMMWV, logistics truck) destroyed | **2** [M] |
| Transport helicopter (UH-60) | **5** [M] |
| APC / Recon (Stryker, AAV) | **5** [M] |
| Tank / IFV (M1A2, M2A3) | **10** [M] |
| Jet / attack helicopter | **10** [M] |
| Cache destroyed | **+30** (gain) [M] |

### 1.6 Win conditions
- **BLUFOR wins** when the required number of caches is destroyed (insurgent "tickets" reach 0).
- **Insurgents win** when BLUFOR tickets reach 0, or when the time limit expires with caches remaining.

### 1.7 Civilians, ROE and penalties [M]
- The **Civilian kit** is an Insurgent kit with no weapons. A civilian carries a cellphone (to spot enemies by placing a map marker), first aid / bandages, and a grappling hook (Civilian Medic). The civilian's job is to gather intel, scout, revive and heal insurgents, and run interference.
- **ROE: a civilian may be shot only if**, within the last **2 min**, they spawned, picked up a weapon kit, used a vehicle or used an epipen, **or** if an armed insurgent is within **5 m horizontally / 1.5 m vertically** of them.
- **Becoming a "protected" civilian**: spawn unarmed (or drop your kit), then wait 2 min and stay away from armed insurgents.
- **Penalties for killing a protected civilian**:

  | Penalty | Amount |
  |---|---|
  | Respawn delay | +120 s per civilian, applied on the shooter's next death, stacking to +5 min |
  | Kit requests | Blocked for **10 min** |
  | Score | Reset to 0, and the kill is hidden |
  | Team intel | Loses IP |

  Repeat offenders get the message "You were arrested for killing too many civilians" (forced death).
- Running over a civilian, or shooting one who is climbing a rope, is also penalised.
- **Civilian vehicles** (empty or unarmed cars, dump trucks, semi-trucks, "ammo techies") are protected if they are empty, have no gun, were last used more than 1 min ago, or have no enemies within 3 m. Destroying one costs the team -5 IP and the player -50 score.

### 1.8 Arresting (zip ties) [M]
- **Restrainers (zip-tie cuffs)** are slot 1 on BLUFOR kits. The player must be **within 1 m** of the target and swing as a melee action.
- A **shotgun loaded with buckshot** ("rubber buckshot") also arrests.
- A **knife kill on an insurgent combatant counts as an arrest**.
- A civilian who commits suicide (to dodge arrest) counts as arrested.
- Effects of an arrest: **+10 IP**, and the arrested civilian gets a **+90 s** respawn penalty.
- Clone suggestion: an arrested player is "downed and cuffed" and cannot be revived.

### 1.9 IEDs and explosives (Insurgent side) [M unless marked]
- **IED** (Sapper kit): placed while prone, with **no arming safeguard**. It is detonated by a cellphone, and **up to 5 IEDs / C4 can be placed at once**. There are two independent detonation chains, so a two-stage ambush is possible.
- Sappers can place **stone markers** to warn friendlies, which can also tip off the enemy.
- Placed explosives automatically get a team map marker.
- BLUFOR Combat Engineers can **defuse** IEDs with a wrench.
- Damage guide (approximate, by analogy to PR C4): one IED destroys a HMMWV and kills its occupants; 2-3 are needed for an APC; MRAP and tank bellies survive a single IED.
- Other insurgent tools:
  - **Grenade traps / trip flares** (booby traps)
  - **RKG-3 anti-tank hand grenades** (some insurgent variants)
  - **Molotovs** (approximate)
  - **Stones**: thrown; minor damage, but several hits kill [M]
  - **VBIEDs**: car bomb or dump-truck bomb vehicles, which respawn every 600-1200 s [M data]
  - **Suicide-vest "martyr"**: PR has a "You died a MARTYR of our insurgency" message, which implies a self-detonation kit exists. Treat it as optional or approximate for the clone.

### 1.10 Collaborator kit [M]
- A medic-like insurgent kit with light personal arms, or an alternate unarmed loadout. **Limit: 2 per squad.**
- Heals with a first aid kit, revives with an epipen, and drags the wounded.
- The unarmed alternate is how insurgents play "civilian medic".

---

## 2. Core "realism" mechanics

### 2.1 Aiming, deviation and settle times
- **No crosshair.** Accuracy comes only from sights (irons, reflex, magnified optics). Hip-fire is heavily deviated.
- **Deviation** is a random cone added to every shot. It grows with movement, firing and stance changes, and shrinks over time while the shooter holds still. An ADS indicator above the compass shows two dots that merge as deviation settles. [M]
- **Optics do not change deviation.** They only change the field of view (FOV). [M]
- **Focus aim**: Shift while aiming adds slight zoom. [M]

| Factor | Settle time / effect |
|---|---|
| Single shot (rifle) | about 1 s back to full accuracy (forum, approximate) |
| After a full-auto burst | about 2 s (forum, approximate) |
| After moving | about 1 s per 1 s of movement, capped at about 5 s (forum, approximate) |
| After turning | about 1.3 s (forum, approximate) |
| After going prone, or after jumping | about 4.4 s of *worse* accuracy, then the best accuracy (forum; manual confirms "prone greatly reduces accuracy for a few moments") |
| Sniper (bolt-action) | **about 8 s after moving, about 4 s after a shot** [M] |
| DMR | about 1 s per shot [M] |
| MMG (M240/PKM), deployed only | about 7 s after long movement [M] |
| HAT | about 10 s to settle [M] |
| Stance ranking (settled) | prone < crouch < stand. Crouch is close to prone (approximate). |

Suggested settled deviation cones (clone tuning, approximate):
- **Rifle ADS**: 0.15° prone, 0.25° crouch, 0.4° standing.
- **Rifle ADS while moving**: about 2-3°.
- **Hip-fire**: 3-6°.

### 2.2 Ballistics
- Projectiles are simulated with **bullet drop** and **muzzle velocity**.
- Drop is noticeable from about 500 m. Scope drop marks do not work in PR, so the aim point is the reticle centre. [M]
- Grenade launcher (UGL): the round **arms after 28 m**. Range is set with a ladder sight. [M]

### 2.3 Stamina [M]
- Sprinting and jumping drain stamina. Standing still regenerates it.
- **At 50% stamina or less, sprinting is disabled** (the indicator blinks).
- **At 10 HP or below, stamina drains to 0 and does not regenerate.**
- Clone defaults (approximate): about 20-25 s of continuous sprint; full regeneration about 30 s standing, faster when prone.

### 2.4 Health, wounds and medical system [M]
| State / item | Behaviour |
|---|---|
| HP display | **No HP bar.** Below 75% HP the screen darkens periodically and tunnel vision sets in. Below 25%, the player coughs and breathes heavily. |
| Bleeding | Continuous HP loss and tunnel vision until the player passes out. **A field dressing does not stop bleeding.** Only a medic's first aid kit fully treats it (approximate interpretation; in PR, being healed by a medic or bandaging stops it). |
| Critically wounded ("downed") | Lethal damage puts the player into the critically wounded state. **The player can be revived for up to 5 min.** Being killed inside a vehicle is often non-revivable. Headshots and large explosions are usually instant death (approximate). |
| Revive limit | If wounded again **within 2 min of a revive**, the player cannot be revived again. |
| Epipen (medic) | Held on the torso. It revives a downed player to **about 10% HP**, and the player still needs healing. |
| First aid kit (Medic / Collaborator) | Hold fire on the target at touching distance. A full heal takes **about 15 s**. Medics can heal themselves. |
| Field dressing | Thrown on the ground; the nearest player gets **+25% HP**. It despawns in 1-2 s. Most kits carry **1**. |
| Drag | Medic only. Must be crouched; uses slot 2. |
| Give up | A dead player can click "Give up". Time already spent waiting counts toward the respawn timer. |

### 2.5 Respawn timers [M]
- **Base respawn: 45-60 s**, with a minimum of 5 s after death. Time spent downed waiting for a medic counts toward the timer.
- Modifiers (apply to the next death; penalties stack to a maximum of +5 min):

| Event | Modifier |
|---|---|
| Death | +3 s |
| Capture or destroy an objective | -3 s |
| Defensive action | -1 s |
| Squad-built outpost | -10 s |
| Teamkill | +15 s each |
| Suicide | +15 s |
| Civilian captured | +90 s |
| Civilian killed outside ROE | +120 s each |
| Friendly cache destroyed | +300 s |

- Clone default (approximate): BLUFOR 45 s, Insurgents 30-45 s.

### 2.6 Rally points, FOBs and spawn points [M]
| Spawn | Rules |
|---|---|
| Squad rally point (RP) | Placed by the squad leader (needs the officer kit) with **at least 2 squad members nearby** and **no enemy within 50 m** on 1 km maps (**125 m** on 2 km and 4 km maps). It is **squad-only** and **expires after 60 s** unless it is within 2 large grid squares of a friendly FOB or a kit-supplying APC. It is disabled when an enemy comes within 50 m (1 km map) or 125 m (larger maps). It can be placed again every **1 min**, or **5 min** if it was overrun. |
| FOB / firebase | Needs the officer kit plus **1 heavy (or 2 light) supply crates within 50 m**. It goes online **90 s** after being built. Max **6 per team**, **200 m** from other FOBs and from the main base. **Spawning locks for 30 s** if **1 enemy is within 10 m, 2 within 50 m, 4 within 100 m, or 8 within 150 m**. |
| Main base | Always available. BLUFOR's main is a no-go zone for insurgents. |
| Kit-supplying vehicles | A rally point near an APC/IFV is persistent, and players can request kits from the vehicle's rear. |

Deployables around a FOB (each needs 2 large crates within 200 m):

| Deployable | Limits |
|---|---|
| HMG emplacement | 2 per FOB, 12 per team |
| TOW / ATGM | 1 per FOB, 3 per team |
| Foxholes, 5 m sandbag walls, 10 m razor wire | Combined total of 60 per team |
| Mortars | 2 per team, not on maps under 2 km |

Insurgent deployables: **SPG-9**, tripod **DShK** AA/HMG, and **roadblocks** (max 100 per team).

### 2.7 Supply and ammo [M]
- **Ammo bag** (Rifleman only) holds 205 points. It gives "a few magazines and a grenade or two" and also rearms emplacements.

| Item | Supply cost (points) |
|---|---|
| Rifle | 60 |
| SMG | 45 |
| PDW | 30 |
| LMG | 150 |
| GPMG | 200 |
| Field dressing | 30 |
| Epipen | 60 |
| Light AT | 70 |
| Medium AT | 80 |
| Heavy AT | 90 |
| Guided AT | 120 |
| Kit request | 250 |

| Supply source | Points |
|---|---|
| Ammo box | 500 |
| Light crate | 1,500 (about 6 kits) |
| Heavy crate | 3,000 (about 12 kits) |

### 2.8 Squad system [M + ~]
- A team has up to about 9 squads. The **max squad size is 8** (older builds used 6).
- Players who are not in a squad cannot request kits, and servers kick solo players.
- The **squad leader (SL)** carries the officer kit. The SL places rally points, builds FOBs and hideouts, places squad markers (Attack/Target, Defend, Move, Observe, Build, Demolish), talks to the commander over radio, and requests support.
- **Commander** (one per team): talks to SLs, places orders, and approves artillery or mortars. A commander RP needs the commander, an SL and 4 squad members nearby.

### 2.9 Kits: requirements and limits [M]
**Spawn-menu kits ("Standard")**

| Kit | Per squad | Min. squad size |
|---|---|---|
| Rifleman | unlimited | 1 |
| Officer (SL) | 1 | 2 |
| Medic | 2 | 2 |
| Automatic Rifleman | 1 | 4 |
| Breacher | 1 | 4 |
| Light Anti-Tank (LAT) | 1 | 4 |
| Grenadier | 1 | 6 |

**Request kits ("Specialist")**: requested at a supply crate or the rear of an APC/IFV, with SL permission.

| Kit | Min. squad size |
|---|---|
| Machine Gunner | 6 |
| Marksman | 6 |
| Rifleman AP | 4 |
| Spotter | 2 |
| Combat Engineer | 3 |
| Anti-Air (AA) | 3 |
| Sniper | 3 |
| Heavy Anti-Tank (HAT) | 3 |
| Crewman / Pilot | no limit (request) |

**Team-wide caps by team size (players)**

| Kit | 1-7 | 8-15 | 16-23 | 24-31 | 32+ |
|---|---|---|---|---|---|
| LAT, Grenadier | 1 | 2 | 4 | 5 | 8 |
| MG, Marksman, AP | 1 | 2 | 3 | 3 | 4 |
| Spotter, Engineer, AA, Sniper | 0 | 1 | 1 | 2 | 2 |
| HAT | 0 | 1 | 1 | 1 | 1 |

**Request lockouts**

| Trigger | Lockout |
|---|---|
| Spawning, or getting a limited kit | 2 min |
| Changing squad | 2 min, plus a further penalty |
| Teamkilling a limited-kit holder | +3 min |
| Spamming kit requests | 30 s |
| Killing a civilian | 10 min |

**Insurgent kits**
- **Spawn menu**: Insurgent, Medic / Collaborator, Sapper, Anti-Tank, Cell Leader (limited), Crewman, and Civilian / unarmed.
- **Pick-up kits**: placed in the insurgent main or caches with a 300 s respawn. They come in fixed counts per map. Fallujah West has **6 RPG, 4 Marksman, 2 Sniper, 2 Sniper-alt, 2 Support (MG), 2 Support-alt, 2 Engineer**. Karbala adds **2 AA** pick-ups.

### 2.10 Suppression [M]
Close passing rounds, heavy fire and nearby explosions cause **blur and screen shake**. Clone suggestions (approximate):
- Add deviation while suppressed (about ×2).
- Use vignette, desaturation and audio ducking.
- Trigger on rounds passing within about 3 m.
- Decay over about 3-5 s.

### 2.11 Map grid, markers and spotting [M]
- **Grid**: 13 × 13 squares, **A-M** (columns, left to right) and **1-13** (rows, top to bottom). Each square is split into a **keypad 3×3** subgrid: 7 8 9 on top, 4 5 6 in the middle, 1 2 3 on the bottom.
- Callout format: "**D6 kp2**" or "D6-2".
- **Square size**: 75 m on a 1 km map, 150 m on 2 km, 300 m on 4 km. So a keypad cell is **25 / 50 / 100 m**.
- **No automatic 3D spotting of infantry.** Grunts can only shout a generic "enemy spotted". The SL/officer places map markers and contact reports, up to 3 manual markers each.
- Enemy kills are **not** shown. There is no kill feed for enemies and no enemy alive/dead state on the scoreboard.
- The **SL order marker** shows as a chevron on the compass. A **3D icon appears only within 75 m**.
- **Compass**: notches every 5°, labels every 15°.
- **Friendly ID**: there are no floating name tags at range (PR shows a name only when the player looks at a close friendly, about ≤ 25 m, approximate). Map icons show only squad members and friendly vehicles.

---

## 3. Faction loadouts

PR's kit contents changed between versions. **Weapons are from PR 1.x US Army and Insurgent kits. Magazine and grenade counts are PR-style approximations [~] suitable for the clone.** "1+N" means one loaded magazine plus N spare.

### 3.1 US Army (USMC differences in the notes column)
| Kit | Primary | Secondary / sidearm | Ammo (approx.) | Grenades / equipment | Notes |
|---|---|---|---|---|---|
| Rifleman | M4A1 + ACOG TA31 (4x) | none | 1+7 × 30 | 2× M67 frag, 2× M18 smoke, 1 field dressing, **ammo bag**, shovel, restrainers, knife | USMC: M16A4 + RCO |
| Rifleman (iron / CCO alt) | M4A1 + M68 CCO | none | 1+7 × 30 | same as Rifleman | CQB variant |
| Rifleman AT (LAT) | M4A1 (M68 CCO) | **M136 AT4** | 1+5 × 30; 1 AT4 (single-shot) | 1 M67, 1 M18, field dressing, restrainers | USMC: SMAW-D or AT4 |
| Grenadier | M4A1 + **M203** (ladder sight) | none | 1+6 × 30; **8-10× 40 mm HE + 2-3 smoke** | 1 M67, 1 M18, field dressing, restrainers | |
| Automatic Rifleman | **M249 SAW** (iron or M145) | none | 1+3 × 200-round box (PR belts behave like about 100-200 rounds) | **no frags**, 1-2 M18, field dressing | bipod deploy |
| Machine Gunner (request) | **M240B** + M145 | M9 | 1+3 × 100-round belt (approx.) | 1 M18, field dressing | deploy-only, about 7 s settle |
| Marksman (request) | **M110 SASS** (or M14 EBR in some versions), 3.5-10x | M9 | 1+6 × 20 | 1 M67, 1 M18 | DMR, about 1 s per shot |
| Sniper (request) | **M24 SWS** 10x (US Army) / M40A3 (USMC) | M9 | 5-round internal; about 25-30 rounds total | 1 signal smoke, ghillie (approx.) | about 8 s / 4 s settle |
| Spotter (request) | M4A1 ACOG | none | 1+6 | binoculars / laser designator (GLTD), grappling hook | |
| Medic | M4A1 (M68 CCO / irons) | none | 1+5 × 30 | **4-5 smoke**, first aid kit, epipens (about 5 uses), several field dressings, restrainers | only kit that drags |
| Combat Engineer (request) | M4A1 or M1014 shotgun | none | 1+5 × 30 | **wrench** (repair, defuse), **large C4 ×2-3** (only kit with large C4), **M15 AT mines ×2-3**, 1 M18 | destroys caches |
| Breacher | M4A1 (CCO) | **M1014 / M870 shotgun** (slug and buckshot; buckshot arrests) | 1+5 × 30; 8-16 shells | **small C4 ×2-3**, grappling hook, 1 M67, 2 M18 | |
| Rifleman AP | M4A1 ACOG | none | 1+6 × 30 | **M18A1 Claymore ×2-4** (5 s arm) | |
| HAT (request) | M4A1 (CCO) | **SMAW** (USMC) / **Javelin** (US Army; PR models it as wire-guided, about 600 m wire) | 1+3 × 30; 2-3 HEAA rockets (SMAW) or 2 missiles | 1 M18 | about 10 s settle; one shot kills light or medium armour |
| AA (request) | M4A1 | **FIM-92 Stinger** | 1+3; 2 missiles | none | omit for the clone |
| Officer / Squad Leader | M4A1 + ACOG (or M68) | **M9** | 1+6 × 30; 1+3 × 15 (M9) | 1 M67, **2 M18 + signal smoke (red/purple)**, binoculars, officer radio, field dressing, restrainers | rally point, FOB, markers |
| Crewman (request) | M4A1 carbine (CCO) or MP7-style PDW | none | 1+3 × 30 | binoculars, wrench (some versions) | can repair vehicles (approx.) |
| Pilot (request) | none | **M9** | 1+3 × 15 | signal smoke, parachute | |

**All BLUFOR kits** carry a knife and **restrainers**. A field dressing ×1 is standard.

### 3.2 Insurgents (Iraqi "Middle Eastern Insurgents", PR faction code `meinsurgent`)
PR randomises or offers alternate loadouts per kit. Counts are approximate [~].

| Kit | Primary (alternates) | Secondary | Ammo (approx.) | Equipment |
|---|---|---|---|---|
| **Insurgent** (rifleman, spawn) | **AKM / AK-47** (alts: Vz.58, SKS, FN FAL, G3, Lee-Enfield, sawn-off / pump shotgun, PPSh/SMG) | none | 1+5 × 30 (7.62×39) | 1-2 F1/RGD-5 frags (some variants carry **RKG-3 AT grenades**, **grenade traps / trip flares** or **Molotovs** instead of extra ammo), 1 smoke, field dressing, stones, shovel |
| **Insurgent: Ambush / Booby-trap variant** | AKS-74U or AK (fewer magazines) | none | 1+2 × 30 | **Grenade traps** (tripwire), trip flares, RKG-3 |
| **Sapper** (spawn) | Makarov PM, or a short weapon | none | 1+3 × 8 (Makarov) | **IEDs ×3-5** (cellphone detonation, two chains), stone markers, shovel; **no wrench** |
| **Anti-Tank (RPG)** (spawn or pickup `riflemanat`) | AKS-74U or no rifle | **RPG-7** (iron sights or PGO-7) | 1+2 × 30; **3-4 rockets** (mix of PG-7V / PG-7VL HEAT and **OG-7V frag**) | 1 frag |
| **Medic / Collaborator** (limit 2 per squad) | AKS-74U or Makarov (light arms); unarmed alt | none | 1+3 | first aid kit, **epipens**, field dressings, smoke ×3, grappling hook (civilian medic) |
| **Machine Gunner** (pickup `support`) | **PKM** (100 / 200-round belts) | none | 1+2 × 100-round belts | none |
| **Machine Gunner alt** (pickup `support_alt`) | **RPK** (40 / 75-round) | none | 1+5 × 40 | 1 frag |
| **Marksman** (pickup) | **SVD Dragunov** PSO-1 4x, or scoped Lee-Enfield No.4 (T) | Makarov | 1+5 × 10 | none |
| **Sniper** (pickup `sniper` / `sniper_alt`) | **SVD** or **Lee-Enfield No.4 Mk I(T)** 3.5x / Mosin-Nagant (alt) | Makarov | about 30-40 rounds | none |
| **Engineer** (pickup) | AK or shotgun | none | 1+4 | **wrench** (repair technicals, repair caches, defuse), IED or C4-equivalent explosive |
| **AA** (pickup on some maps) | none | **SA-7 Strela / 9K32** | 2 missiles | none |
| **Cell Leader** (limited, officer equivalent) | AKM / AK-47 | Makarov | 1+5 | **cellphone/radio** (markers, spotting), binoculars, smoke, field dressing; builds **hideouts** and roadblocks, places rally points |
| **Crewman** | AKS-74U | none | 1+3 | none |
| **Civilian / Unarmed** | none | none | none | cellphone (spot / mark enemies), field dressings, sometimes first aid kit; must stay "clean" for 2 min to be protected |

- **Suicide bomber**: the PR message "You died a MARTYR" suggests one exists. It is not in the standard kit list, so treat it as optional. If implemented: a vest with a large charge (about 10 m kill radius) and a 2 s arm delay.
- **Flare gun**: not confirmed for PR insurgents. The trip flare is confirmed. Optional.

---

## 4. Weapon data (real-world [R] plus game notes)

Velocity is muzzle velocity (m/s). Effective range is point-target range.

### 4.1 Small arms
| Weapon | Calibre | Velocity (m/s) | RoF (rpm, cyclic) | Magazine | Effective range | Weight (kg, empty) | Modes | Typical sight |
|---|---|---|---|---|---|---|---|---|
| **M4A1** | 5.56×45 NATO | 880-910 | 700-950 | 30 STANAG | 500 m | 2.9 (3.4 loaded) | Semi / Auto | ACOG TA31 4x / M68 CCO |
| **M16A4** | 5.56×45 | 948 | 700-950 (burst-limited) | 30 | 550 m | 3.3 | Semi / 3-round burst | RCO (TA31) |
| **M249 SAW** | 5.56×45 | 915 | 750-1000 | 200-round box / 100-round pouch (or 30 STANAG) | 600 m point, 800 m area | 7.5 (10 loaded) | Auto | Irons / M145 3.4x |
| **M240B** | 7.62×51 | 853 | 650-950 | 100 / 200-round belt | 800 m bipod, 1,100 m area (1,800 m tripod) | 12.5 | Auto | Irons / M145 3.4x |
| **M24 SWS** | 7.62×51 (M118LR) | 790 | bolt (about 15-20 aimed rounds/min) | 5 internal | 800 m | 5.4 (with scope) | Bolt | Leupold M3A 10x |
| **M110 SASS** | 7.62×51 | 783 | semi | 10 / 20 | 800 m | 6.9 (with scope) | Semi | Leupold 3.5-10x |
| **M14 EBR** (alt DMR) | 7.62×51 | 850 | 700-750 | 20 | 500-800 m | 5.1 | Semi | 3.5-10x |
| **M9 Beretta** | 9×19 | 381 | semi | 15 | 50 m | 0.95 | Semi | Irons |
| **M1014** shotgun | 12 ga | about 400 (00 buckshot) | semi | 7 tube | 40 m | 3.8 | Semi | Ghost ring |
| **AKM** | 7.62×39 | 715 | 600 | 30 | 350 m | 3.1 | Semi / Auto | Irons (notch) |
| **AK-47** (Type 3) | 7.62×39 | 715 | 600 | 30 | 350 m | 3.5 | Semi / Auto | Irons |
| **AKS-74U** | 5.45×39 | 735 | 650-735 | 30 | 200-300 m | 2.7 | Semi / Auto | Irons (flip, 350/500 m) |
| **RPK** | 7.62×39 | 745 | 600 | 40 box / 75 drum | 460 m point, 800 m area | 4.8 | Semi / Auto | Irons |
| **PKM** | 7.62×54R | 825 | 650 | 100 / 200 / 250 belt | 1,000 m | 7.5 | Auto | Irons |
| **SVD Dragunov** | 7.62×54R | 830 | semi | 10 | 800 m | 4.3 (with scope) | Semi | PSO-1 4x |
| **Lee-Enfield No.4** | .303 British | 744 | bolt (about 20-30 aimed rounds/min) | 10 (2× 5-round chargers) | 500 m (sniper about 600-800 m) | 4.1 | Bolt | Irons / No.32 3.5x |
| **Makarov PM** | 9×18 | 315 | semi | 8 | 50 m | 0.73 | Semi | Irons |
| **SKS** (alt) | 7.62×39 | 735 | semi | 10 fixed | 400 m | 3.85 | Semi | Irons |
| **Vz.58** (alt) | 7.62×39 | 705 | 800 | 30 | 400 m | 2.9 | Semi / Auto | Irons |

### 4.2 Explosives, launchers and heavy weapons
| Weapon | Calibre / type | Velocity (m/s) | RoF | Capacity | Effective range | Weight (kg) | Effect / notes |
|---|---|---|---|---|---|---|---|
| **M203** | 40×46 mm LV | 76 | single (5-7 rounds/min) | 1 | 150 m point, 350 m area | 1.4 (launcher) | M406 HE casualty radius about 5 m; arms at 14-27 m (PR: 28 m) |
| **M67 frag** | Comp B, 180 g | thrown (about 30-35 m) | n/a | n/a | n/a | 0.40 | 4-5.5 s fuse; kill radius about 5 m, casualty about 15 m |
| **M18 smoke** | | thrown | n/a | n/a | n/a | 0.54 | burns 50-90 s (PR: 30 s to build, over 1 min to last) |
| **F1 frag** | TNT 60 g, cast-iron body | thrown (30-45 m) | n/a | n/a | n/a | 0.60 | 3.2-4.2 s fuse; lethal about 10-15 m, fragments to 200 m |
| **RGD-5** | TNT 110 g | thrown (40-50 m) | n/a | n/a | n/a | 0.31 | 3.2-4.2 s fuse; lethal about 5-10 m, casualty about 15-20 m |
| **RKG-3** AT grenade | HEAT, drogue chute | thrown (15-20 m) | n/a | n/a | n/a | 1.07 | about 150-220 mm RHA, top attack |
| **M136 AT4** | 84 mm HEAT | 285 | single-shot, disposable | 1 | 300 m (vehicle-size target) | 6.7 | about 400-420 mm RHA; arms about 10 m |
| **SMAW** | 83 mm HEAA / HEDP | 220 | single (reloadable) | 1 | 500 m (tank-size target) | 7.7 (13.4 loaded) | about 600 mm RHA; 9 mm spotting rifle |
| **FGM-148 Javelin** | 127 mm tandem HEAT | missile | single | 1 | 2,500 m (65 m minimum) | 22.3 | top attack; fire-and-forget in reality |
| **RPG-7** | 40 mm tube, overcalibre warheads | 115 m/s launch, about 295 m/s max (rocket motor) | 3-4 rounds/min | 1 | 200 m moving target, 300-500 m static | 6.3 (7.0 with PGO-7 2.7x) | self-destructs at about 920 m (4.5 s) |
| ↳ PG-7V | 85 mm HEAT | | | | | 2.2 (round) | about 260-300 mm RHA |
| ↳ PG-7VL | 93 mm HEAT | | | | | 2.6 | about 500-600 mm RHA |
| ↳ OG-7V | 40 mm HE-FRAG | | | | | 2.0 | anti-personnel, about 7 m lethal |
| **IED** | 1-2× 152/155 mm artillery shell, or 10-50 kg HME | n/a | command-detonated | n/a | n/a | n/a | kills unarmoured vehicles; MRAPs designed to survive (approx.) |
| **DShK / DShKM** | 12.7×108 | 850 | 600 | 50-round belt box | 1,500-2,000 m | 34 (gun), 157 (wheeled mount) | AA tripod or technical mount |
| **SPG-9** | 73 mm recoilless | 435 launch, about 700 with sustainer (PG-9) | 5-6 rounds/min | 1 | 800 m (AT), 4,500 m (OG-9 HE) | 47.5 (with tripod) | about 300-400 mm RHA |
| **M2 Browning** | .50 BMG (12.7×99) | 890 | 450-600 | 100 / 105-round belt can | 1,800 m | 38 (gun), 58 (tripod) | HMMWV / Stryker / tank cupola |
| **Mk19** | 40×53 mm HV | 241 | 325-375 | 32 / 48-round belt can | 1,500 m point, 2,212 m area | 35.2 | HEDP: about 5 m kill, 15 m casualty, 50 mm armour |
| **ZU-23-2** | 23×152 mm | 970 | 2× 1,000 (about 400 practical) | 2× 50-round boxes | 2,500 m (AA), about 2,000 m (ground) | 950 (towed) | on Ural / technical |
| **M224 / 60 mm mortar**, insurgent 82 mm mortar | | | | | | | PR uses an off-map "mortar team" barrage (every 20 min for insurgents) |
| **Molotov** | about 1 L petrol | thrown (about 20 m) | n/a | n/a | n/a | about 1 | fire area 3-5 m, burns 10-15 s (approx.) |

### 4.3 Suggested PR-style damage model (clone, approximate)
- Player HP: **100**.
- Rifle hits (5.56 / 7.62×39 / 7.62×51):
  - Torso hit: about 40-60 damage plus bleeding. Two hits down a player; 7.62 is closer to one hit.
  - Limb hit: about 25-35 damage plus bleeding.
  - Head hit: 100 (instant death, not revivable).
- Sniper and .303 / 7.62×54R torso hit: a one-hit down.
- Pistol: about 25-35 per hit.
- Grenade: 100 within about 4 m, falling off linearly to 0 at about 12 m.
- RPG OG-7V: 100 within 4 m, falling off to 0 at 10 m.

---

## 5. Vehicles

### 5.1 US forces
| Vehicle | PR key | Crew / seats | Armament | Speed (road) | Armour / weight | Size (L×W×H) | BLUFOR ticket cost |
|---|---|---|---|---|---|---|---|
| **M1114 HMMWV (up-armoured)** | `us_jep_hmmwv_uparmored` | 4 + 1 gunner = 5 | M2 .50 **or** Mk19 **or** M240B in a ring turret with gun shield | 105-113 km/h | resists 7.62 AP and artillery fragments; vulnerable to RPGs, IEDs and .50; about 5.5 t | 4.99 × 2.30 × 1.90 m | 2 |
| **M1151 HMMWV** | (similar) | 5 | M2 / Mk19 / M240B (some with **CROWS** remote weapon station) | about 113 km/h | similar to the M1114 (about 5.9 t) | 4.93 × 2.30 × 1.90 m | 2 |
| **M1025 HMMWV (soft / support)** | `us_jep_hmmwv`, `_support` | 4-5 | M2 or none; the support variant carries a supply crate | about 113 km/h | unarmoured, about 2.6 t | 4.57 × 2.16 × 1.83 m | 2 |
| **MRAP: MaxxPro / Cougar 4×4** | not in PR US (approx.) | 2 + 4-6, plus gunner | M2 / Mk19 / M240 turret | 105 km/h | V-hull **survives 1 IED**; resists 7.62 AP; 14-18 t | 6.5 × 2.5 × 3.0 m | 2-5 (clone choice) |
| **M2A3 Bradley IFV** (PR: M2A2) | `us_ifv_m2a2` | 3 + 6 dismounts | **25 mm M242** (single, 100 or 200 rpm; APDS/HEI), **2× TOW**, M240C coax | 56-66 km/h | resists 14.5 mm frontally plus ERA/BRAT; RPG-vulnerable on the sides; 27-30 t | 6.55 × 3.6 × 2.98 m | 10 |
| **M1126 Stryker ICV** | `us_apc_stryker`, `_mk19`, ACV variant | 2 + 9 dismounts | RWS **M2** or **Mk19** | 97 km/h | 14.5 mm-proof with add-on armour, **slat armour vs RPG**; 16.5-19 t | 6.95 × 2.72 × 2.64 m | 5 |
| **Stryker command vehicle (ACV)** | `us_acv_stryker` | 2 + several | none / M2 | 97 km/h | as Stryker | as Stryker | n/a (respawns 30 s; mobile kit / spawn point) |
| **M1A2 Abrams** (PR: M1A1 on USMC maps) | `us_tnk_m1a1` | 4 (driver, gunner, commander, loader) | **120 mm M256** (about 40 rounds: HEAT/MPAT and SABOT), **M2** cupola, 2× **M240** (coax and loader) | 67 km/h | composite armour, frontal arc immune to RPG/AT4; vulnerable at rear, top and sides; 62-66 t | 9.77 (gun forward) × 3.66 × 2.44 m | 10 |
| **Logistics truck (M1083 FMTV / M35)** | `us_trk_logistics` | 2 + cargo | none | 90 km/h | unarmoured, about 8-10 t | 7.0 × 2.4 × 2.9 m | 2 |
| **Support truck** | `us_trk_support` | 2 | none | 90 km/h | unarmoured | | 2 |
| **UH-60 Black Hawk** | `us_the_uh60` | 2 pilots + 2 door gunners (M240H or M134) + 8-11 troops | 2 door guns | 280 km/h cruise, 295 km/h max | light armour; RPG or DShK can down it; about 5-10 t | 19.8 m overall (fuselage 15.3 m), rotor 16.4 m | 5 |
| **OH-58D Kiowa / AH-6** | `us_ahe_kiowa`, `us_ahe_ah6` | 2 | rockets plus .50 / miniguns | about 200 km/h | | | 10 |

Asset respawn times on the Insurgency 64 layers (from map data):

| Asset | Respawn |
|---|---|
| HMMWV | 600 s |
| Support HMMWV | 300 s |
| Logistics truck | 300 s |
| Stryker | 600 s |
| Bradley | 900 s |
| Tank | 1,200 s |
| Command vehicle (ACV) | 30 s |

### 5.2 Insurgent / civilian
| Vehicle | PR key | Seats | Armament | Speed | Notes |
|---|---|---|---|---|---|
| **Toyota Hilux technical (DShK)** | `civ_jep_technical(_blue/_red/_black)` | 2 cab + 1 gunner + 2-3 in the bed | **DShK 12.7 mm** | about 150-160 km/h | unarmoured; respawns 600 s; about 1.6 t; 5.3 × 1.8 × 1.8 m |
| **Technical (SPG-9)** | `civ_atm_technical` | 2 + gunner | **SPG-9 73 mm** recoilless | about 150 km/h | AT; respawns 600-900 s |
| **Rocket technical** | `civ_atm_technical_rocket` | 2 + gunner | rocket pod (107 mm Type 63 / 57 mm S-5) | about 150 km/h | respawns 1,200 s |
| **Ural / truck with ZU-23-2** | `civ_aav_uralzu232` | 2 + gunner | **ZU-23-2** twin 23 mm | about 85 km/h | AA and anti-ground |
| **Civilian sedan (various colours)** | `civ_jep_car*`, `civ_jep_zastava900ak` | 4-5 | none | about 140 km/h | protected under the ROE when empty |
| **Supply pick-up ("ammo techie")** | `civ_jep_support` | 2-4 | none | about 150 km/h | carries a supply crate for insurgent hideouts |
| **Dirt bike / Honda CB500** | `civ_bik_dirtbike`, `civ_bik_hondacb500` | 2 | none | about 120-160 km/h | fast scouting |
| **VBIED car** | `civ_jep_car_bomber_*` | 1-2 | detonates (driver-triggered), about 15-20 m lethal radius | about 140 km/h | looks civilian; respawns 600-900 s, first available at 10-15 min |
| **VBIED dump truck** | `civ_trk_dumpster_bomber` | 1-2 | large blast, about 25-30 m | about 90 km/h | respawns 600-1,200 s |
| **Dump truck / semi ("Fake Gary")** | `civ_trk_dumpster`, `civ_trk_semi` | 2 | none | about 90 km/h | protected civilian vehicle |
| **SPG-9 static** | deployable | 1 | SPG-9 | n/a | built at a hideout; 10 s reload; max 3 per team |
| **DShK tripod (AA/HMG)** | deployable | 1 | DShK | n/a | built at a hideout |
| **Mortar** | off-map "mortar team" | n/a | 82 mm barrage | n/a | every 20 min |
| **BRDM-2** | not on Iraqi insurgent layers | 4 | 14.5 mm KPVT + 7.62 PKT | 95 km/h | 7 t; omit for authenticity |

---

## 6. Maps

### 6.1 PR Insurgency maps (Middle East), from map data
Coordinates are metres from the map centre. X runs west to east; Z runs south to north.

| Map | Size | BLUFOR (64-player layer) | BLUFOR main | Insurgent HQ | Distance main → HQ |
|---|---|---|---|---|---|
| **Al Basrah** | 2 km | British (650 tickets) | "Airport" (-666, +525), W/NW | "Mosque" (+337, -319), SE | about 1.3 km |
| **Fallujah West** | **1 km** | **USMC (550)** | "USMC Operations Base" (-424, -390), SW corner | "Insurgency Base" (+325, +330), NE | about 1.05 km |
| **Karbala** | 2 km | Polish (500); 128-player layer is **US Army (500)** | "Camp Lima" (+818, +875), NE corner | "Mosque" (-25, -227), centre-south | about 1.5 km |
| **Ramiel** | 2 km | US Army (650) vs ARF | "UNOSOM" (-400, -750), S | "ARF Camp" (+48, +804), N | about 1.6 km |
| **Shahadah** | 2 km | Polish (500) | | | |
| **Sbeneh Outskirts** | 2 km | SAA (700) vs Syrian Rebels | | | |
| Kokan / Lashkar Valley / Korengal | 2 km / 2 km / 1 km | US Army / German / Canadian vs Taliban | | | |

Asset loadouts:
- **Karbala 128 (US Army)**: 3 HMMWV, Stryker, Stryker Mk19, M2A2 Bradley, UH-60, Kiowa, 2 logistics trucks, 2 support trucks, Stryker command vehicle.
- **Fallujah West 64 (USMC)**: 2 HMMWV, 2 support HMMWVs, AAV-7, M2A2 Bradley, 2 logistics trucks, LAV-C2 command vehicle.
- **Insurgent side**: technicals (DShK, SPG-9, rocket), ZU-23 Ural, about 6 dirt bikes, about 10 civilian cars, 1-2 VBIEDs, 2 ammo pick-ups, plus pick-up kits.

### 6.2 Al Basrah (PR)
- Based on Basra, southern Iraq, on the **Shatt al-Arab** waterway, which has many **canals** (the "Venice of the Middle East").
- **Map layout**:
  - BLUFOR main sits at the **airport** on the city's outskirts, with open desert and farmland between it and the city.
  - The **dense city core** has many canals crossed by **bridges**. Insurgents commonly sap the bridges to channel BLUFOR.
  - Other features: an **old British fort / compound**, palm-lined riverbanks, and the insurgent **Mosque** HQ deep in the SE of the city.
- **Look**: tan and grey concrete, flat-roofed 1-3 storey houses, walled courtyards, narrow alleys, market streets, minarets, and water towers.

### 6.3 Fallujah West (PR)
- A 1 km map of the western part of Fallujah, modelled on the **2004 battles** (Vigilant Resolve and Phantom Fury).
- **Real city**:
  - About 3 km across, with more than 2,000 blocks in a **grid pattern**.
  - Bounded by the **Euphrates to the west**, a **railway to the north** and a **highway (Highway 10) to the east**. The "Brooklyn" bridge (old green steel truss) crosses the Euphrates.
  - Districts include the **Jolan** (old, dense, narrow streets in the NW) and an **industrial district** in the SE.
- **PR layout**:
  - USMC operations base in the SW corner; insurgent base in the NE.
  - Very dense **CQB**: walled compounds and rooftops connected by stairs.
  - Plenty of rubble and wrecked cars.

### 6.4 Recommended first map for the clone: "mid-sized Middle-Eastern city"
**Size**: 1.0-1.5 km playable, inside a 2 km terrain with a buffer. Use a PR-style grid: a 1 km map gives **13×13 squares of 75 m**.

| Zone | Content |
|---|---|
| BLUFOR main (corner, about 150×150 m) | HESCO walls, a gate, a helipad, a vehicle depot and supply crates. The surrounding terrain is open desert or farmland, with about 300-500 m of approach to the city edge. Insurgents may not enter. |
| Highway | A 4-lane divided road with lamp posts and burnt-out cars. It skirts the city on one side and links to the BLUFOR main. |
| Outskirts | Palm groves (dense date palms), irrigation **canals** (about 4-8 m wide, crossed by 2-4 bridges), mud-brick farm compounds and berms. |
| Residential grid (most of the map) | Flat-roofed **courtyard houses**: 1-3 storeys, about 10×15 m footprint, 2.5-3 m perimeter walls, metal gates, roof parapets of about 1 m, external stairs to the roof, and water tanks on the roofs. Streets are 6-10 m wide and alleys 2-4 m. |
| Old town / souk | Narrow winding lanes; a **covered market (souk)** with awnings, stalls and shop shutters; 2-4 storey buildings with balconies. |
| Mosque (insurgent HQ, no-go for BLUFOR) | A domed prayer hall with 1-2 **minarets** (25-40 m tall), a courtyard and a perimeter wall. A second, smaller mosque can stand elsewhere as a landmark. |
| Industrial / factory district | Warehouses, a silo or water tower, fuel tanks, a rail spur, fenced yards and containers. |
| Ruins | Collapsed houses, rubble piles and craters. These are good cache sites and give multiple routes. |
| Other landmarks | Water tower, cell tower, government building / police station, school, soccer field, traffic circle with a monument. |

**Cache sites**: place about 12-16 candidate locations in building interiors (ground floors, courtyards, basements), spread across the city with at least about 150 m between them. Each round, 5-6 caches are picked at random and spawned in sequence, 2 active at a time.

**Spawn layout pattern** (matches PR): BLUFOR main sits in one corner. The insurgent HQ (mosque) is about 1-1.5 km away, inside the city's far side or centre. Insurgent hideouts and caches lie between them.

**Palette**: sand (#C8B08A), concrete grey (#A8A39A), mud-brick (#B08D64), palm green (#5E6B3A), canal water (murky green-brown #4F5A3E). Use a hazy sky.

---

## 7. Real-world reference: Iraq 2003-2011
- **Insurgent arms**:
  - Most common: AK-pattern rifles (Type 56, AKM, Tabuk), **RPK / PKM**, **RPG-7** (main AT and anti-personnel weapon), and Dragunov / **Tabuk** sniper rifles.
  - Less common: SKS and Lee-Enfield.
  - Heavier weapons: **82 / 120 mm mortars**, 107 mm rockets, DShK and 14.5 mm technicals.
- **The IED was the #1 killer of US troops.** IEDs were built from artillery shells (daisy-chained) or homemade explosives (HME). Later came **EFPs** (explosively formed penetrators, which defeat up-armoured HMMWVs). Triggers included command wires, cellphones, garage-door openers and pressure plates. VBIEDs and suicide vests were also used.
- **Insurgent tactics**:
  - Hit-and-run attacks
  - Rooftop and complex ambushes (IED followed by small-arms fire and RPG)
  - Snipers and "shoot-and-scoot" mortars
  - Hiding weapons caches in homes, mosques, schools and palm groves
  - Blending into civilians
- **US forces**:
  - Infantry: M4 / M16A4 with ACOG or M68, M249, M240B, M203, AT4, Javelin; M24 / M110 / Mk12 SPR (DMR), plus M14 EBR.
  - Vehicles: M1114 / M1151 up-armoured HMMWVs, then **MRAPs from 2007**, plus Strykers, Bradleys and M1A1/A2 Abrams.
  - Air: UH-60, AH-64, OH-58D.
- **Counter-insurgency (COIN) activities**: cordon-and-search operations, tips from informants (in-game, this is the "intel"), detainee operations (zip ties), and escalation-of-force ROE (in-game, the civilian rules).

---

## 8. Squad and Six Days in Fallujah (2026-10-22)

The user asked for gameplay closer to **Squad** and **Six Days in Fallujah** (SDIF), and for weapon handling like the Squad
AKM reference video (frames in `tools/blender/src-assets/ref/video/`). Published numbers are scarce; values marked ~ are tuning.

**Aiming (Squad v6 Infantry Combat Overhaul onwards).** No PR settle cone: the round leaves along the barrel with a small
mechanical dispersion. Difficulty is visible: the sights sway (slow breathing figure-of-eight ~0.3 Hz plus a faster
tremor), more standing than crouched or prone, much more when moving, out of breath (x2.5-3 when empty) or suppressed;
hold breath steadies the sights for a few seconds (not under suppression). Recoil climbs; the shooter pulls down; part of
each kick recovers. ADS time per weapon (~0.25 s carbine to ~0.7 s MMG). Implemented in `game/soldier.ts`
(`swayTarget`, `recoil`, `devTarget` = mechanical `acc` when aimed, hip cone otherwise).

**Reloads (AKM, from the video, ~4.5 s).** 0-0.75 s rifle lifted, muzzle up ~40 deg, rolled ~30-45 deg clockwise, support hand
to the magazine; ~1 s magazine rocked forward off its front lug and taken away; the rifle waits canted while the hand
fetches a fresh one; ~2.5-3.25 s the new magazine is hooked on the lug and rocked back; ~3.5 s seated; back to ready by
~4.5 s. Empty reloads add the charging handle (reach over the top on the AK). Squad keeps partly used magazines.
Implemented as keyframed choreography in `player/handling.ts` (AK, AR, belt, bolt, pistol, RPG).

**Bipods and rests.** Squad/RO2/Insurgency: deploy on the ground (prone) or on a horizontal surface just below the sights
(window sill, wall top, sandbags, car bonnet) ~0-0.6 m under the eye and within ~0.75 m ahead; deploy ~0.5 s; sway
x0.1-0.25, recoil x0.3-0.5; traverse limited (~+-30-45 deg yaw, -10..+15 deg pitch); moving or a stance change folds it.
Insurgency default: bipod -70 % recoil, -75 % sway. Weapons without a bipod get a smaller "rest" bonus (sway x0.4).
Players complain when detection is fussy - keep it forgiving. Implemented in `Soldier.supportSpot/toggleBipod` (G).

**Suppression.** Squad: stronger rounds suppress more and longer; the view desaturates and blurs at the edges and sway
grows; explosions suppress everyone. ~Radii 2 m pistol, 3 m 5.56, 4 m 7.62, 5 m MG; decay starts after ~1-1.5 s.

**Hit feedback / lethality.** Squad v6 made players "more likely to be wounded or suppressed, less likely to be killed
outright"; SDIF is very lethal at close range. Every hit must visibly interrupt the target (players complain about AI
"running, jumping and shooting after direct hits"): flinch/stagger, aim knocked off, a short reaction delay. Impacts must
read at range: dust jet and hanging puff, chips, sparks, persistent holes, tracers every 4th-5th round on MGs.

**SDIF enemy AI** (Highwire devlogs): insurgents constantly move against the player, set ambushes outdoors and in houses,
lure into traps, "stalk, flank and ambush", grenade, lay suppressive fire, notice flashlights and muzzle flashes; they
must not see through walls, should lose accuracy with range and have a short acquisition delay; never respawn into
cleared rooms. Procedural Architecture reshuffles interiors so routes cannot be learned.

**SDIF friendly fireteam.** Player = team leader; context "GO" command: move, watch a sector, suppress (tap while
aiming), form up, stack up / breach a door, plant C4, mark IED. While moving, members trail and cover the rear.

**Doctrine encoded in `ai/team.ts`** (FM 3-21.8, FM 3-06.11). Fireteam wedge (AR left rear, grenadier right rear,
~3-5 m in town), file in narrow streets/indoors. Contact drill: react (return fire, cover, ~3 s) -> report -> base of fire
(AR + 1) keeps the enemy suppressed while the maneuver element flanks 45-90 deg off the line of fire -> shift/lift fire as
the maneuver nears the objective -> assault (grenade, then in) -> consolidate/search. Insurgent cell (2-5 men, RPK/PKM,
RPG): hide at windows and roofs, spring the ambush when the enemy is in the kill zone, shoot and scoot (never stay at one
window more than a few bursts), stalk the flank, fall back house to house, hunt when it hears nothing.

Sources: joinsquad.com/archive/revisiting-the-infantry-combat-overhaul-c0926, joinsquad.com/archive/squad-update-6-0-release-notes-eb2b4,
patched.gg/games/squad/squad-104-patch-notes, insurgency.fandom.com/wiki/Bipod, forums.sixdays.com (DEVLOG July 2024 enemy AI;
SITREP Fireteam AI Breaching; Autumn 2025 update notes), dualshockers.com/six-days-in-fallujah-how-to-command-your-team,
en.wikipedia.org/wiki/Six_Days_in_Fallujah, US Army FM 3-21.8 and FM 3-06.11.

## 9. Armour in Project Reality, and the M1A2 / M2A3 (2026-11-06)
PR rules (official manual, "Operating Vehicles"): armour needs the **Crewman** kit (driver and gunner); tanks and IFVs have separate driver and gunner seats; the gunner seat works only with a driver (or cupola gunner) aboard, and the gunner must wait ~30 s after taking the seat before the cannon can be aimed (turret warm-up; we use 12 s M1A2 / 8 s M2A3). Ammunition: AP, HE, ATGM, coax; **switching type causes a firing delay** (we unload and reload). Wire-guided missiles need the vehicle stationary ~7 s (we use 4 s for the TOW). Smoke: two quick volleys. FCS with laser rangefinder (min ~150 m). Armour strongest at the front/turret, weaker at the rear and top, sides and tracks in between; heavy damage disables (no movement or traverse) until repaired; exiting a burning vehicle wounds. Vehicles respawn at the main base after a long timer.
Real data used (approximate, public sources): **M1A2** 62 t, 9.83 m with gun, 3.66 m wide, AGT1500 turbine, 67 km/h road / ~48 km/h cross-country, turret 360° in ~9 s, gun −9°/+20°, 120 mm M256 (M829A3 APFSDS 1555 m/s ~750–800 mm RHA; M830A1 HEAT-MP 1410 m/s ~600 mm CE), 42 rounds (34 ready in the bustle behind blow-out panels), coax M240C, loader's M240, commander's M2HB (CROWS); armour ~950 KE / ~1500 CE turret front, ~570/~800 glacis, thin sides/rear/top. **M2A3** 30.4 t, 6.55 m, 61 km/h, 25 mm M242 (single/100/200 rpm; M919 APFSDS ~100 mm, M792 HEI), 300 ready (70 AP / 230 HE), TOW-2A (2 ready + 5, ~900 mm tandem, 280 m/s, 3.75 km), crew 3 + 6 dismounts, aluminium/spaced-steel hull with BRAT reactive tiles.
Threats: RPG-7 PG-7VL ~500 mm, PG-7VR tandem ~600 mm behind ERA, 9M113M Konkurs ~750 mm tandem (SACLOS, ~200 m/s, 4 km), 155 mm shell IEDs (belly and tracks).
Combined-arms doctrine applied by the AI: mounted infantry ride the Bradley to a dismount point short of the objective, the tank overwatches from further back, then both follow the dismounts and fire where they are in contact; infantry clear buildings room by room (FM 3-06.11) with armour support from the street.
Sources: https://www.realitymod.org/manual/en/operating_vehicles.html ; https://squad.fandom.com/wiki/M2A3 ; Army fact files / FAS / Jane's figures as summarised in game/data/vehicles.ts.

## Sources
- PR Manual: Game Modes: https://www.realitymod.org/manual/en/game_modes.html
- PR Manual: The Basics (spawns, respawn, tickets, medical, grid, supply): https://www.realitymod.org/manual/en/the_basics.html
- PR Manual: Kits: https://www.realitymod.org/manual/en/kits.html
- PR Manual: The Squad Leader (RP, FOB, hideouts, deployables): https://www.realitymod.org/manual/en/the_squad_leader.html
- PR Manual: The Civilian (ROE, arrests, penalties): https://www.realitymod.org/manual/en/the_civilian.html
- PR Manual: Weapons & Equipment (deviation, IEDs, C4, medical): https://www.realitymod.org/manual/en/weapons_and_equipment.html
- PR Map Gallery data (layers, tickets, assets, respawn times): https://mapgallery.realitymod.org/json/levels.json and `/json/<map>/gpm_insurgency_<size>.json`
- PR localisation strings (kit names, insurgency messages): https://github.com/realitymod/pr-localization
- PR forum, v0.9 insurgency changes (cache count and ticket history): https://forum.realitymod.org/viewtopic.php?p=1241927
- PR forum, weapon deviation settle-time breakdown: https://forum.realitymod.org/viewtopic.php?p=993858
- MWI West Point, Fallujah urban warfare case study: https://mwi.westpoint.edu/urban-warfare-case-study-6-first-battle-of-fallujah/
- Real-world weapon and vehicle specs: standard manufacturer and military reference figures (FM 3-22.x, Jane's-style values), given as approximate ranges.
