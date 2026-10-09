import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RollbackPresentationPolicy } from '../policy/RollbackPresentationPolicy';

/**
 * The rollback entry inside a user message's system selection menu.
 *
 * Two user-message surfaces raise that menu — the short bubble's own `Text` and
 * the full-text panel's — and the entry has to be the same one on both, so the
 * menu item is built once here instead of twice: the item's id is what the click
 * callback matches on, and two copies of that string would be two entries the day
 * one of them is renamed.
 *
 * `onCreateMenu` appends the item to the items the system offered, which is what
 * keeps copy and select-all intact; `onMenuItemClick` claims only its own id and
 * returns false for everything else, so the system runs its own logic untouched
 * (`Text.editMenuOptions`, API 12+).
 */
export class RollbackSelectionMenu {
  /**
   * Id this app's extended item answers to.
   *
   * `TextMenuItemId.of` takes it as its whole identity, so the value is only ever
   * compared against itself and never shown to a user.
   */
  private static readonly ITEM_ID: string = 'openbitfun_rollback_to_message';

  /** Options for one surface's `Text`. */
  static options(onRollback: () => void): EditMenuOptions {
    return {
      onCreateMenu: (menuItems: Array<TextMenuItem>): Array<TextMenuItem> => {
        const items: Array<TextMenuItem> = menuItems.slice();
        items.push({
          content: RemoteI18n.t(RollbackPresentationPolicy.ROLLBACK_ITEM_KEY),
          id: TextMenuItemId.of(RollbackSelectionMenu.ITEM_ID)
        });
        return items;
      },
      onMenuItemClick: (menuItem: TextMenuItem, _range: TextRange): boolean => {
        if (!menuItem.id.equals(TextMenuItemId.of(RollbackSelectionMenu.ITEM_ID))) {
          return false;
        }
        onRollback();
        return true;
      }
    };
  }
}
