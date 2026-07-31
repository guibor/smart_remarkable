use anyhow::Result;
use log::debug;

use std::collections::HashMap;
use std::{thread, time};

use evdev::{uinput::VirtualDevice, AttributeSet, EventType as EvdevEventType, InputEvent, KeyCode as EvdevKey};

pub const TABLET_WRITE_BACK_MAX_UTF8_BYTES: usize = 2_048;
pub const TABLET_WRITE_BACK_MAX_KEYPRESSES: usize = 600;
pub const TABLET_WRITE_BACK_MAX_ESTIMATED_MS: usize = 6_500;
const ESTIMATED_KEYPRESS_MS: usize = 10;
const ESTIMATED_STYLE_AND_SYNC_MS: usize = 20;

pub struct Keyboard {
    device: Option<VirtualDevice>,
    key_map: HashMap<char, (EvdevKey, bool)>,
    progress_count: u32,
    no_draw_progress: bool,
}

impl Keyboard {
    pub fn new(no_draw: bool, no_draw_progress: bool) -> Self {
        let device = if no_draw { None } else { Some(Self::create_virtual_device()) };

        Self {
            device,
            key_map: Self::create_key_map(),
            progress_count: 0,
            no_draw_progress,
        }
    }

    fn create_virtual_device() -> VirtualDevice {
        debug!("Creating virtual keyboard");
        let mut keys = AttributeSet::new();

        keys.insert(EvdevKey::KEY_A);
        keys.insert(EvdevKey::KEY_B);
        keys.insert(EvdevKey::KEY_C);
        keys.insert(EvdevKey::KEY_D);
        keys.insert(EvdevKey::KEY_E);
        keys.insert(EvdevKey::KEY_F);
        keys.insert(EvdevKey::KEY_G);
        keys.insert(EvdevKey::KEY_H);
        keys.insert(EvdevKey::KEY_I);
        keys.insert(EvdevKey::KEY_J);
        keys.insert(EvdevKey::KEY_K);
        keys.insert(EvdevKey::KEY_L);
        keys.insert(EvdevKey::KEY_M);
        keys.insert(EvdevKey::KEY_N);
        keys.insert(EvdevKey::KEY_O);
        keys.insert(EvdevKey::KEY_P);
        keys.insert(EvdevKey::KEY_Q);
        keys.insert(EvdevKey::KEY_R);
        keys.insert(EvdevKey::KEY_S);
        keys.insert(EvdevKey::KEY_T);
        keys.insert(EvdevKey::KEY_U);
        keys.insert(EvdevKey::KEY_V);
        keys.insert(EvdevKey::KEY_W);
        keys.insert(EvdevKey::KEY_X);
        keys.insert(EvdevKey::KEY_Y);
        keys.insert(EvdevKey::KEY_Z);

        keys.insert(EvdevKey::KEY_1);
        keys.insert(EvdevKey::KEY_2);
        keys.insert(EvdevKey::KEY_3);
        keys.insert(EvdevKey::KEY_4);
        keys.insert(EvdevKey::KEY_5);
        keys.insert(EvdevKey::KEY_6);
        keys.insert(EvdevKey::KEY_7);
        keys.insert(EvdevKey::KEY_8);
        keys.insert(EvdevKey::KEY_9);
        keys.insert(EvdevKey::KEY_0);

        // Add punctuation and special keys
        keys.insert(EvdevKey::KEY_SPACE);
        keys.insert(EvdevKey::KEY_ENTER);
        keys.insert(EvdevKey::KEY_TAB);
        keys.insert(EvdevKey::KEY_LEFTSHIFT);
        keys.insert(EvdevKey::KEY_MINUS);
        keys.insert(EvdevKey::KEY_EQUAL);
        keys.insert(EvdevKey::KEY_LEFTBRACE);
        keys.insert(EvdevKey::KEY_RIGHTBRACE);
        keys.insert(EvdevKey::KEY_BACKSLASH);
        keys.insert(EvdevKey::KEY_SEMICOLON);
        keys.insert(EvdevKey::KEY_APOSTROPHE);
        keys.insert(EvdevKey::KEY_GRAVE);
        keys.insert(EvdevKey::KEY_COMMA);
        keys.insert(EvdevKey::KEY_DOT);
        keys.insert(EvdevKey::KEY_SLASH);

        keys.insert(EvdevKey::KEY_BACKSPACE);
        keys.insert(EvdevKey::KEY_ESC);

        keys.insert(EvdevKey::KEY_LEFTCTRL);
        keys.insert(EvdevKey::KEY_LEFTALT);

        VirtualDevice::builder()
            .unwrap()
            .name("Virtual Keyboard")
            .with_keys(&keys)
            .unwrap()
            .build()
            .unwrap()
    }

    fn create_key_map() -> HashMap<char, (EvdevKey, bool)> {
        let mut key_map = HashMap::new();

        // Lowercase letters
        key_map.insert('a', (EvdevKey::KEY_A, false));
        key_map.insert('b', (EvdevKey::KEY_B, false));
        key_map.insert('c', (EvdevKey::KEY_C, false));
        key_map.insert('d', (EvdevKey::KEY_D, false));
        key_map.insert('e', (EvdevKey::KEY_E, false));
        key_map.insert('f', (EvdevKey::KEY_F, false));
        key_map.insert('g', (EvdevKey::KEY_G, false));
        key_map.insert('h', (EvdevKey::KEY_H, false));
        key_map.insert('i', (EvdevKey::KEY_I, false));
        key_map.insert('j', (EvdevKey::KEY_J, false));
        key_map.insert('k', (EvdevKey::KEY_K, false));
        key_map.insert('l', (EvdevKey::KEY_L, false));
        key_map.insert('m', (EvdevKey::KEY_M, false));
        key_map.insert('n', (EvdevKey::KEY_N, false));
        key_map.insert('o', (EvdevKey::KEY_O, false));
        key_map.insert('p', (EvdevKey::KEY_P, false));
        key_map.insert('q', (EvdevKey::KEY_Q, false));
        key_map.insert('r', (EvdevKey::KEY_R, false));
        key_map.insert('s', (EvdevKey::KEY_S, false));
        key_map.insert('t', (EvdevKey::KEY_T, false));
        key_map.insert('u', (EvdevKey::KEY_U, false));
        key_map.insert('v', (EvdevKey::KEY_V, false));
        key_map.insert('w', (EvdevKey::KEY_W, false));
        key_map.insert('x', (EvdevKey::KEY_X, false));
        key_map.insert('y', (EvdevKey::KEY_Y, false));
        key_map.insert('z', (EvdevKey::KEY_Z, false));

        // Uppercase letters
        key_map.insert('A', (EvdevKey::KEY_A, true));
        key_map.insert('B', (EvdevKey::KEY_B, true));
        key_map.insert('C', (EvdevKey::KEY_C, true));
        key_map.insert('D', (EvdevKey::KEY_D, true));
        key_map.insert('E', (EvdevKey::KEY_E, true));
        key_map.insert('F', (EvdevKey::KEY_F, true));
        key_map.insert('G', (EvdevKey::KEY_G, true));
        key_map.insert('H', (EvdevKey::KEY_H, true));
        key_map.insert('I', (EvdevKey::KEY_I, true));
        key_map.insert('J', (EvdevKey::KEY_J, true));
        key_map.insert('K', (EvdevKey::KEY_K, true));
        key_map.insert('L', (EvdevKey::KEY_L, true));
        key_map.insert('M', (EvdevKey::KEY_M, true));
        key_map.insert('N', (EvdevKey::KEY_N, true));
        key_map.insert('O', (EvdevKey::KEY_O, true));
        key_map.insert('P', (EvdevKey::KEY_P, true));
        key_map.insert('Q', (EvdevKey::KEY_Q, true));
        key_map.insert('R', (EvdevKey::KEY_R, true));
        key_map.insert('S', (EvdevKey::KEY_S, true));
        key_map.insert('T', (EvdevKey::KEY_T, true));
        key_map.insert('U', (EvdevKey::KEY_U, true));
        key_map.insert('V', (EvdevKey::KEY_V, true));
        key_map.insert('W', (EvdevKey::KEY_W, true));
        key_map.insert('X', (EvdevKey::KEY_X, true));
        key_map.insert('Y', (EvdevKey::KEY_Y, true));
        key_map.insert('Z', (EvdevKey::KEY_Z, true));

        // Numbers
        key_map.insert('0', (EvdevKey::KEY_0, false));
        key_map.insert('1', (EvdevKey::KEY_1, false));
        key_map.insert('2', (EvdevKey::KEY_2, false));
        key_map.insert('3', (EvdevKey::KEY_3, false));
        key_map.insert('4', (EvdevKey::KEY_4, false));
        key_map.insert('5', (EvdevKey::KEY_5, false));
        key_map.insert('6', (EvdevKey::KEY_6, false));
        key_map.insert('7', (EvdevKey::KEY_7, false));
        key_map.insert('8', (EvdevKey::KEY_8, false));
        key_map.insert('9', (EvdevKey::KEY_9, false));

        // Special characters
        key_map.insert('!', (EvdevKey::KEY_1, true));
        key_map.insert('@', (EvdevKey::KEY_2, true));
        key_map.insert('#', (EvdevKey::KEY_3, true));
        key_map.insert('$', (EvdevKey::KEY_4, true));
        key_map.insert('%', (EvdevKey::KEY_5, true));
        key_map.insert('^', (EvdevKey::KEY_6, true));
        key_map.insert('&', (EvdevKey::KEY_7, true));
        key_map.insert('*', (EvdevKey::KEY_8, true));
        key_map.insert('(', (EvdevKey::KEY_9, true));
        key_map.insert(')', (EvdevKey::KEY_0, true));
        key_map.insert('_', (EvdevKey::KEY_MINUS, true));
        key_map.insert('+', (EvdevKey::KEY_EQUAL, true));
        key_map.insert('{', (EvdevKey::KEY_LEFTBRACE, true));
        key_map.insert('}', (EvdevKey::KEY_RIGHTBRACE, true));
        key_map.insert('|', (EvdevKey::KEY_BACKSLASH, true));
        key_map.insert(':', (EvdevKey::KEY_SEMICOLON, true));
        key_map.insert('"', (EvdevKey::KEY_APOSTROPHE, true));
        key_map.insert('<', (EvdevKey::KEY_COMMA, true));
        key_map.insert('>', (EvdevKey::KEY_DOT, true));
        key_map.insert('?', (EvdevKey::KEY_SLASH, true));
        key_map.insert('~', (EvdevKey::KEY_GRAVE, true));

        // Common punctuation
        key_map.insert('-', (EvdevKey::KEY_MINUS, false));
        key_map.insert('=', (EvdevKey::KEY_EQUAL, false));
        key_map.insert('[', (EvdevKey::KEY_LEFTBRACE, false));
        key_map.insert(']', (EvdevKey::KEY_RIGHTBRACE, false));
        key_map.insert('\\', (EvdevKey::KEY_BACKSLASH, false));
        key_map.insert(';', (EvdevKey::KEY_SEMICOLON, false));
        key_map.insert('\'', (EvdevKey::KEY_APOSTROPHE, false));
        key_map.insert(',', (EvdevKey::KEY_COMMA, false));
        key_map.insert('.', (EvdevKey::KEY_DOT, false));
        key_map.insert('/', (EvdevKey::KEY_SLASH, false));
        key_map.insert('`', (EvdevKey::KEY_GRAVE, false));

        // Whitespace
        key_map.insert(' ', (EvdevKey::KEY_SPACE, false));
        key_map.insert('\t', (EvdevKey::KEY_TAB, false));
        key_map.insert('\n', (EvdevKey::KEY_ENTER, false));

        // Action keys, such as backspace, escape, ctrl, alt
        key_map.insert('\x08', (EvdevKey::KEY_BACKSPACE, false));
        key_map.insert('\x1b', (EvdevKey::KEY_ESC, false));

        key_map
    }

    pub fn key_down(&mut self, key: EvdevKey) -> Result<()> {
        if let Some(device) = &mut self.device {
            device.emit(&[(InputEvent::new(EvdevEventType::KEY.0, key.code(), 1))])?;
            device.emit(&[InputEvent::new(EvdevEventType::SYNCHRONIZATION.0, 0, 0)])?;
            thread::sleep(time::Duration::from_millis(1));
        }
        Ok(())
    }

    pub fn key_up(&mut self, key: EvdevKey) -> Result<()> {
        if let Some(device) = &mut self.device {
            device.emit(&[(InputEvent::new(EvdevEventType::KEY.0, key.code(), 0))])?;
            device.emit(&[InputEvent::new(EvdevEventType::SYNCHRONIZATION.0, 0, 0)])?;
            thread::sleep(time::Duration::from_millis(1));
        }
        Ok(())
    }

    pub fn string_to_keypresses(&mut self, input: &str) -> Result<()> {
        self.string_to_keypresses_with_guard(input, || Ok(false), false)
    }

    pub fn string_to_keypresses_guarded(
        &mut self,
        input: &str,
        should_abort: impl FnMut() -> Result<bool>,
    ) -> Result<()> {
        self.string_to_keypresses_with_guard(input, should_abort, true)
    }

    fn keypress_batch(key: EvdevKey, shift: bool) -> Vec<InputEvent> {
        let mut events = Vec::with_capacity(if shift { 4 } else { 2 });
        if shift {
            events.push(InputEvent::new(
                EvdevEventType::KEY.0,
                EvdevKey::KEY_LEFTSHIFT.code(),
                1,
            ));
        }
        events.push(InputEvent::new(EvdevEventType::KEY.0, key.code(), 1));
        events.push(InputEvent::new(EvdevEventType::KEY.0, key.code(), 0));
        if shift {
            events.push(InputEvent::new(
                EvdevEventType::KEY.0,
                EvdevKey::KEY_LEFTSHIFT.code(),
                0,
            ));
        }
        events
    }

    fn string_to_keypresses_with_guard(
        &mut self,
        input: &str,
        mut should_abort: impl FnMut() -> Result<bool>,
        reject_unsupported: bool,
    ) -> Result<()> {
        if let Some(device) = &mut self.device {
            if should_abort()? {
                anyhow::bail!("Physical input changed before keyboard output");
            }
            // make sure we are synced before we start; this might be paranoia
            device.emit(&[InputEvent::new(EvdevEventType::SYNCHRONIZATION.0, 0, 0)])?;
            thread::sleep(time::Duration::from_millis(10));

            for c in input.chars() {
                if should_abort()? {
                    anyhow::bail!("Physical input changed during keyboard output");
                }
                if let Some(&(key, shift)) = self.key_map.get(&c) {
                    // One guarded, balanced uinput batch per character keeps
                    // Shift from being stranded and minimizes the interval
                    // between the physical-input check and key emission.
                    device.emit(&Self::keypress_batch(key, shift))?;
                    thread::sleep(time::Duration::from_millis(10));
                } else if reject_unsupported {
                    anyhow::bail!("Tablet keyboard cannot emit the complete response");
                }
            }
        }
        Ok(())
    }

    /// Bound the interval during which physical input must remain absent for a
    /// tablet write-back. The complete answer still reaches canonical WhatsApp
    /// when this returns false; no partial local insertion is begun.
    pub fn tablet_write_back_is_bounded(&self, input: &str) -> bool {
        let supported = input.chars().filter(|character| self.key_map.contains_key(character)).count();
        let estimated_ms = ESTIMATED_STYLE_AND_SYNC_MS.saturating_add(supported.saturating_mul(ESTIMATED_KEYPRESS_MS));
        !input.is_empty()
            && self.no_draw_progress
            && input.len() <= TABLET_WRITE_BACK_MAX_UTF8_BYTES
            && supported > 0
            && input.chars().all(|character| self.key_map.contains_key(&character))
            && supported <= TABLET_WRITE_BACK_MAX_KEYPRESSES
            && estimated_ms <= TABLET_WRITE_BACK_MAX_ESTIMATED_MS
    }

    fn selection_handshake_batch(key: EvdevKey) -> [InputEvent; 8] {
        [
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTCTRL.code(), 1),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTALT.code(), 1),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTSHIFT.code(), 1),
            InputEvent::new(EvdevEventType::KEY.0, key.code(), 1),
            InputEvent::new(EvdevEventType::KEY.0, key.code(), 0),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTSHIFT.code(), 0),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTALT.code(), 0),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTCTRL.code(), 0),
        ]
    }

    fn selection_handshake_chord(&mut self, key: EvdevKey) -> Result<()> {
        if let Some(device) = &mut self.device {
            // VirtualDevice::emit appends exactly one SYN_REPORT. Keeping the
            // explicit chord free of SYN means a returned trailing-sync error
            // cannot occur after an earlier embedded SYN already activated
            // the QML transaction.
            device.emit(&Self::selection_handshake_batch(key))?;
            thread::sleep(time::Duration::from_millis(10));
        }
        Ok(())
    }

    fn emit_prepare_with_restore(mut emit_chord: impl FnMut(EvdevKey) -> Result<()>) -> Result<()> {
        if let Err(prepare_error) = emit_chord(EvdevKey::KEY_8) {
            // Treat every reported prepare failure as potentially
            // side-effecting. The restore shortcut is idempotent before
            // prepare and after close, so this is safe even when the kernel
            // rejected the original chord before QML observed it.
            return match emit_chord(EvdevKey::KEY_7) {
                Ok(()) => Err(prepare_error),
                Err(restore_error) => Err(anyhow::anyhow!(
                    "{}; prepared-selection restoration also failed: {}",
                    prepare_error,
                    restore_error
                )),
            };
        }
        Ok(())
    }

    /// Ask the firmware-pinned QML to revalidate the live stock selection,
    /// hide only its tint/controls, and publish a nonce-bound prepare ack.
    pub fn prepare_captured_selection(&mut self) -> Result<()> {
        Self::emit_prepare_with_restore(|key| self.selection_handshake_chord(key))
    }

    /// Ask QML to revalidate the prepared selection, close it through the
    /// stock SceneSelectionHandler path, and publish a nonce-bound close ack.
    pub fn dismiss_captured_selection(&mut self) -> Result<()> {
        self.selection_handshake_chord(EvdevKey::KEY_9)
    }

    /// Restore chrome for a prepared selection when local capture fails. The
    /// QML shortcut is disabled after close, so this cannot reopen a selection.
    pub fn restore_prepared_selection(&mut self) -> Result<()> {
        self.selection_handshake_chord(EvdevKey::KEY_7)
    }

    fn key_cmd(&mut self, button: &str, shift: bool) -> Result<()> {
        self.key_down(EvdevKey::KEY_LEFTCTRL)?;
        if shift {
            self.key_down(EvdevKey::KEY_LEFTSHIFT)?;
        }
        self.string_to_keypresses(button)?;
        if shift {
            self.key_up(EvdevKey::KEY_LEFTSHIFT)?;
        }
        self.key_up(EvdevKey::KEY_LEFTCTRL)?;
        Ok(())
    }

    pub fn key_cmd_title(&mut self) -> Result<()> {
        self.key_cmd("1", false)?;
        Ok(())
    }

    pub fn key_cmd_subheading(&mut self) -> Result<()> {
        self.key_cmd("2", false)?;
        Ok(())
    }

    pub fn key_cmd_body(&mut self) -> Result<()> {
        self.key_cmd("3", false)?;
        Ok(())
    }

    fn emit_body_command_guarded(
        mut should_abort: impl FnMut() -> Result<bool>,
        mut emit: impl FnMut(&[InputEvent]) -> Result<()>,
    ) -> Result<()> {
        if should_abort()? {
            anyhow::bail!("Physical input changed before text style activation");
        }
        // Modifier down, style key down/up, and modifier up form one uinput
        // batch. There is no guard gap that can leave Ctrl held or apply the
        // style key after focus moves.
        emit(&[
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTCTRL.code(), 1),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_3.code(), 1),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_3.code(), 0),
            InputEvent::new(EvdevEventType::KEY.0, EvdevKey::KEY_LEFTCTRL.code(), 0),
        ])
    }

    pub fn key_cmd_body_guarded(&mut self, should_abort: impl FnMut() -> Result<bool>) -> Result<()> {
        if let Some(device) = &mut self.device {
            Self::emit_body_command_guarded(should_abort, |events| {
                device.emit(events)?;
                Ok(())
            })?;
            thread::sleep(time::Duration::from_millis(10));
        }
        Ok(())
    }

    pub fn key_cmd_bullet(&mut self) -> Result<()> {
        self.key_cmd("4", false)?;
        Ok(())
    }

    pub fn progress(&mut self, note: &str) -> Result<()> {
        if self.no_draw_progress {
            return Ok(());
        }
        self.string_to_keypresses(note)?;
        self.progress_count += note.len() as u32;
        Ok(())
    }

    pub fn progress_end(&mut self) -> Result<()> {
        if self.no_draw_progress {
            return Ok(());
        }
        // Send a backspace for each progress
        for _ in 0..self.progress_count {
            self.string_to_keypresses("\x08")?;
        }
        self.progress_count = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::{EvdevEventType, EvdevKey, Keyboard, TABLET_WRITE_BACK_MAX_KEYPRESSES};

    #[test]
    fn tablet_write_back_accepts_the_exact_keypress_boundary() {
        let keyboard = Keyboard::new(true, true);
        assert!(keyboard.tablet_write_back_is_bounded(&"a".repeat(TABLET_WRITE_BACK_MAX_KEYPRESSES)));
    }

    #[test]
    fn tablet_write_back_rejects_one_keypress_over_the_boundary() {
        let keyboard = Keyboard::new(true, true);
        assert!(!keyboard.tablet_write_back_is_bounded(&"a".repeat(TABLET_WRITE_BACK_MAX_KEYPRESSES + 1)));
    }

    #[test]
    fn tablet_write_back_rejects_empty_or_entirely_unsupported_text() {
        let keyboard = Keyboard::new(true, true);
        assert!(!keyboard.tablet_write_back_is_bounded(""));
        assert!(!keyboard.tablet_write_back_is_bounded("שלום"));
        assert!(!keyboard.tablet_write_back_is_bounded("תשובה 10"));
        for mixed in ["answer’s", "answer—10", "answer 🙂", "x = √2"] {
            assert!(!keyboard.tablet_write_back_is_bounded(mixed), "{mixed:?} must fail before the first key");
        }
    }

    #[test]
    fn guarded_body_style_is_one_balanced_batch_and_abort_emits_nothing() {
        let mut emitted = Vec::new();
        assert!(Keyboard::emit_body_command_guarded(
            || Ok(true),
            |events| {
                emitted.extend_from_slice(events);
                Ok(())
            },
        )
        .is_err());
        assert!(emitted.is_empty());

        Keyboard::emit_body_command_guarded(
            || Ok(false),
            |events| {
                emitted.extend_from_slice(events);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(emitted.len(), 4);
        assert_eq!(emitted[0].event_type(), EvdevEventType::KEY);
        assert_eq!(emitted[0].code(), EvdevKey::KEY_LEFTCTRL.code());
        assert_eq!(emitted[0].value(), 1);
        assert_eq!(emitted[1].code(), EvdevKey::KEY_3.code());
        assert_eq!(emitted[1].value(), 1);
        assert_eq!(emitted[2].code(), EvdevKey::KEY_3.code());
        assert_eq!(emitted[2].value(), 0);
        assert_eq!(emitted[3].code(), EvdevKey::KEY_LEFTCTRL.code());
        assert_eq!(emitted[3].value(), 0);
    }

    #[test]
    fn shifted_keypress_batch_always_releases_shift_in_the_same_batch() {
        let shifted = Keyboard::keypress_batch(EvdevKey::KEY_A, true);
        assert_eq!(shifted.len(), 4);
        assert_eq!(shifted[0].code(), EvdevKey::KEY_LEFTSHIFT.code());
        assert_eq!(shifted[0].value(), 1);
        assert_eq!(shifted[1].code(), EvdevKey::KEY_A.code());
        assert_eq!(shifted[1].value(), 1);
        assert_eq!(shifted[2].code(), EvdevKey::KEY_A.code());
        assert_eq!(shifted[2].value(), 0);
        assert_eq!(shifted[3].code(), EvdevKey::KEY_LEFTSHIFT.code());
        assert_eq!(shifted[3].value(), 0);

        let unshifted = Keyboard::keypress_batch(EvdevKey::KEY_A, false);
        assert_eq!(unshifted.len(), 2);
        assert!(unshifted
            .iter()
            .all(|event| event.code() == EvdevKey::KEY_A.code()));
    }

    #[test]
    fn selection_prepare_reported_after_side_effect_is_restored() {
        let prepared = Cell::new(false);
        let mut keys = Vec::new();
        let result = Keyboard::emit_prepare_with_restore(|key| {
            keys.push(key);
            if key == EvdevKey::KEY_8 {
                prepared.set(true);
                return Err(anyhow::anyhow!(
                    "simulated emit error after QML observed prepare"
                ));
            }
            assert_eq!(key, EvdevKey::KEY_7);
            prepared.set(false);
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(keys, vec![EvdevKey::KEY_8, EvdevKey::KEY_7]);
        assert!(!prepared.get());
    }

    #[test]
    fn selection_handshake_batch_is_balanced_and_has_no_embedded_sync() {
        let events = Keyboard::selection_handshake_batch(EvdevKey::KEY_8);
        assert_eq!(events.len(), 8);
        assert!(events
            .iter()
            .all(|event| event.event_type() == EvdevEventType::KEY));
        assert_eq!(events[0].code(), EvdevKey::KEY_LEFTCTRL.code());
        assert_eq!(events[0].value(), 1);
        assert_eq!(events[7].code(), EvdevKey::KEY_LEFTCTRL.code());
        assert_eq!(events[7].value(), 0);
    }
}
