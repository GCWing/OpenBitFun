import { describe, it, expect } from '@ohos/hypium';
import {
  ImmersiveMaterialDecision,
  ImmersiveMaterialPolicy,
  ImmersiveMaterialSnapshot,
  ImmersiveSurfaceRecipe,
  ImmersiveSurfaceRecipes,
  ImmersiveSurfaceScene,
  resolveImmersiveMaterial
} from '../main/ets/pages/policy/ImmersiveMaterialPolicy';

// The policy is pure, so the device run is the same decision the host runner
// makes; it is repeated here because this is where the app is built with the real
// ArkTS compiler and the real SDK declarations. Nothing in this file touches
// `uiMaterial`, so the whole suite runs on a device below API 26 as well — which
// is the population the degradation path exists for.
const SCENES: ImmersiveSurfaceScene[] = [
  ImmersiveSurfaceScene.TOP_CHROME,
  ImmersiveSurfaceScene.BOTTOM_CHROME,
  ImmersiveSurfaceScene.SEARCH_FIELD,
  ImmersiveSurfaceScene.FLOATING_MENU,
  ImmersiveSurfaceScene.MODAL_SHEET,
  ImmersiveSurfaceScene.TOAST
];

const INVERTIBLE_LEVELS: string[] = ['thin', 'ultra_thin'];
const MATERIAL_STATES: string[] = ['default', 'enable', 'disable'];
const MOTION_STATES: boolean[] = [false, true];

function snapshot(apiLevel: number, materialState: string, reduceMotion: boolean): ImmersiveMaterialSnapshot {
  return { apiLevel: apiLevel, materialState: materialState, reduceMotion: reduceMotion };
}

function decision(
  scene: ImmersiveSurfaceScene,
  apiLevel: number,
  materialState: string,
  reduceMotion: boolean
): ImmersiveMaterialDecision {
  return resolveImmersiveMaterial(scene, snapshot(apiLevel, materialState, reduceMotion));
}

function recipe(scene: ImmersiveSurfaceScene): ImmersiveSurfaceRecipe {
  return ImmersiveSurfaceRecipes.recipeFor(scene);
}

export default function immersiveMaterialPolicyUnitTest() {
  describe('Immersive material policy', () => {
    it('keeps the recipe each scene asks for', 0, () => {
      const top = recipe(ImmersiveSurfaceScene.TOP_CHROME);
      expect(top.level).assertEqual('ultra_thin');
      expect(top.fallbackBlur).assertEqual('thin');
      expect(top.floorColor).assertEqual('page_bg_overlay');
      expect(top.hairlineColor).assertEqual('line');

      const bottom = recipe(ImmersiveSurfaceScene.BOTTOM_CHROME);
      expect(bottom.level).assertEqual('thin');
      expect(bottom.fallbackBlur).assertEqual('thin');
      expect(bottom.floorColor).assertEqual('card_overlay');

      const search = recipe(ImmersiveSurfaceScene.SEARCH_FIELD);
      expect(search.level).assertEqual('thin');
      expect(search.fallbackBlur).assertEqual('thin');
      expect(search.floorColor).assertEqual('card_overlay');

      const menu = recipe(ImmersiveSurfaceScene.FLOATING_MENU);
      expect(menu.level).assertEqual('thick');
      expect(menu.fallbackBlur).assertEqual('thick');
      expect(menu.floorColor).assertEqual('card');

      const sheet = recipe(ImmersiveSurfaceScene.MODAL_SHEET);
      expect(sheet.level).assertEqual('ultra_thick');
      expect(sheet.fallbackBlur).assertEqual('none');
      expect(sheet.floorColor).assertEqual('page_bg');

      const toast = recipe(ImmersiveSurfaceScene.TOAST);
      expect(toast.level).assertEqual('thin');
      expect(toast.fallbackBlur).assertEqual('none');
      expect(toast.floorColor).assertEqual('toast_background');

      SCENES.forEach((scene: ImmersiveSurfaceScene): void => {
        expect(recipe(scene).hairlineColor).assertEqual('line');
      });
    });

    it('treats an unmapped scene as a solid modal surface', 0, () => {
      // The type system keeps this unreachable from a real call site; the decision
      // still holds for a value that arrives from a remote or persisted payload.
      const unknown: ImmersiveSurfaceScene = 'not_a_scene' as ImmersiveSurfaceScene;
      expect(recipe(unknown).level).assertEqual(recipe(ImmersiveSurfaceScene.MODAL_SHEET).level);
      expect(recipe(unknown).fallbackBlur).assertEqual('none');
    });

    it('asks for no material below API 26', 0, () => {
      [21, 25].forEach((apiLevel: number): void => {
        MATERIAL_STATES.forEach((state: string): void => {
          MOTION_STATES.forEach((reduceMotion: boolean): void => {
            SCENES.forEach((scene: ImmersiveSurfaceScene): void => {
              const resolved = decision(scene, apiLevel, state, reduceMotion);
              expect(resolved.apply).assertFalse();
              expect(resolved.colorInvert).assertFalse();
              expect(resolved.interactive).assertFalse();
              expect(resolved.lightEffect).assertFalse();
            });
          });
        });
      });
    });

    it('asks for a material at API 26 unless the app switched materials off', 0, () => {
      ['default', 'enable'].forEach((state: string): void => {
        MOTION_STATES.forEach((reduceMotion: boolean): void => {
          SCENES.forEach((scene: ImmersiveSurfaceScene): void => {
            const resolved = decision(scene, 26, state, reduceMotion);
            expect(resolved.apply).assertTrue();
            expect(resolved.interactive).assertEqual(!reduceMotion);
            expect(resolved.lightEffect).assertEqual(!reduceMotion);
            expect(resolved.colorInvert).assertEqual(INVERTIBLE_LEVELS.includes(recipe(scene).level));
          });
        });
      });
      MOTION_STATES.forEach((reduceMotion: boolean): void => {
        SCENES.forEach((scene: ImmersiveSurfaceScene): void => {
          expect(decision(scene, 26, 'disable', reduceMotion).apply).assertFalse();
        });
      });
    });

    it('never treats an unmeasurable API level as API 26', 0, () => {
      const unmeasurable: number[] = [0, -21, NaN, Infinity];
      unmeasurable.forEach((apiLevel: number): void => {
        expect(decision(ImmersiveSurfaceScene.TOP_CHROME, apiLevel, 'default', false).apply).assertFalse();
      });
      expect(ImmersiveMaterialPolicy.IMMERSIVE_MATERIAL_API_LEVEL).assertEqual(26);
    });

    it('answers the whole fallback surface whenever the material is refused', 0, () => {
      [21, 25].forEach((apiLevel: number): void => {
        SCENES.forEach((scene: ImmersiveSurfaceScene): void => {
          const resolved = decision(scene, apiLevel, 'default', false);
          const expected = recipe(scene);
          expect(resolved.level).assertEqual(expected.level);
          expect(resolved.fallbackBlur).assertEqual(expected.fallbackBlur);
          expect(resolved.floorColor).assertEqual(expected.floorColor);
          expect(resolved.hairlineColor).assertEqual(expected.hairlineColor);
        });
      });
    });
  });
}
