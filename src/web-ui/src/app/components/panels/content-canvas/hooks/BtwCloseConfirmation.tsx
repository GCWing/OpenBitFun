import { Checkbox } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import styles from './BtwCloseConfirmation.module.css';

interface BtwCloseConfirmationProps {
  onSkipChange: (skip: boolean) => void;
}

export function BtwCloseConfirmation({ onSkipChange }: BtwCloseConfirmationProps) {
  const { t } = useI18n('components');

  return (
    <div
      className={styles.root}
      data-openbitfun-component="confirm-dialog"
      data-openbitfun-part="message"
    >
      <div className={styles.message}>{t('tabs.confirmCloseBtw')}</div>
      <Checkbox
        className={styles.checkbox}
        size="sm"
        label={t('tabs.skipCloseBtwConfirmation')}
        onCheckedChange={onSkipChange}
      />
    </div>
  );
}
