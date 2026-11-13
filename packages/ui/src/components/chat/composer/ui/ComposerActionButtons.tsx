/**
 * The composer's send / queue / stop control.
 *
 * Which one is shown depends on whether a turn is running: idle sends, a busy
 * session with content offers both a follow-up action (above) and stop, a busy
 * session without content offers only stop. The follow-up action does what
 * Enter does under the follow-up setting: it queues, or it steers and then
 * looks like the plain send button.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { buttonVariants } from '@/components/ui/button-variants';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type ComposerActionButtonsProps = {
    isMobile: boolean;
    footerIconButtonClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    currentSessionId: string | null;
    newSessionDraftOpen: boolean;
    onPrimaryAction: () => void;
    onAbort: () => void;
    /** Replaces "Send message" as the accessible name and tooltip (parallel mode says how many runs start). */
    sendLabel?: string;
    /** A double Escape in this composer stops the run (useKeyboardShortcuts), so the Stop tooltip names it. */
    escapeStops?: boolean;
    /** Desktop and VS Code: the controls are filled circles of this size. Mobile keeps the bare icons. */
    roundSizeClass?: string;
};

export const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        footerIconButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        currentSessionId,
        newSessionDraftOpen,
        onPrimaryAction,
        onAbort,
        sendLabel,
        escapeStops = false,
        roundSizeClass,
    } = props;
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const queuesFollowUp = useMessageQueueStore((state) => state.followUpBehavior) === 'queue';
    // Stopping takes Escape twice (a single press only arms it).
    const escapeKey = escapeStops ? formatShortcutForDisplay(getEffectiveShortcutCombo('abort_run', shortcutOverrides), '') : '';
    const abortShortcut = escapeKey ? `${escapeKey} ${escapeKey}` : undefined;

    // Round: the app's filled button as a circle. Bare: the tinted icon alone.
    const buttonClass = (variant: 'default' | 'destructive', bareClass: string | false, extra?: string) => roundSizeClass
        ? cn(buttonVariants({ variant, size: 'icon' }), 'rounded-full', roundSizeClass, extra)
        : cn(footerIconButtonClass, bareClass, extra);

    const sendText = sendLabel ?? t('chat.chatInput.actions.sendMessageAria');
    const sendEnabled = canSend && (Boolean(currentSessionId) || newSessionDraftOpen);
    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            disabled={!sendEnabled}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }

                event.preventDefault();
                onPrimaryAction();
            }}
            className={buttonClass('default', sendEnabled ? 'text-primary hover:text-primary' : 'opacity-30')}
            aria-label={sendText}
        >
            <Icon name="send-plane-2" className={cn(sendIconSizeClass)} />
        </button>
    );

    if (!canAbort) {
        if (isMobile) return sendButton;
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    {/* The span keeps the tooltip on a disabled button, which takes no pointer events. */}
                    <span className="inline-flex">{sendButton}</span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>{sendText}</TooltipContent>
            </Tooltip>
        );
    }

    const followUpLabel = t(queuesFollowUp ? 'chat.chatInput.actions.queueMessageAria' : 'chat.chatInput.actions.sendMessageAria');

    return (
        <div className="relative">
            {hasContent ? (
                <Tooltip>
                <TooltipTrigger asChild>
                <button
                    type="button"
                    disabled={!currentSessionId}
                    onClick={(event) => {
                        if (isMobile) {
                            event.preventDefault();
                        }
                        onPrimaryAction();
                    }}
                    className={buttonClass(
                        'default',
                        currentSessionId ? 'text-primary hover:text-primary' : 'opacity-30',
                        'absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1',
                    )}
                    aria-label={followUpLabel}
                >
                    <Icon name="send-plane-2" className={cn(sendIconSizeClass, queuesFollowUp && '-rotate-90 rtl:rotate-90')} />
                </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>{followUpLabel}</TooltipContent>
                </Tooltip>
            ) : null}
            <Tooltip>
            <TooltipTrigger asChild>
            <button
                type="button"
                onClick={onAbort}
                className={buttonClass('destructive', 'text-[var(--status-error)] hover:text-[var(--status-error)]')}
                aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
            >
                <StopIcon className={roundSizeClass ? 'size-3.5' : stopIconSizeClass} />
            </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}><TooltipLabelWithShortcut label={t('chat.chatInput.actions.stopGeneratingAria')} shortcut={abortShortcut} /></TooltipContent>
            </Tooltip>
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
    && prev.canSend === next.canSend
    && prev.canAbort === next.canAbort
    && prev.hasContent === next.hasContent
    && prev.currentSessionId === next.currentSessionId
    && prev.newSessionDraftOpen === next.newSessionDraftOpen
    && prev.onPrimaryAction === next.onPrimaryAction
    && prev.onAbort === next.onAbort
    && prev.sendLabel === next.sendLabel
    && prev.escapeStops === next.escapeStops
    && prev.roundSizeClass === next.roundSizeClass
));
