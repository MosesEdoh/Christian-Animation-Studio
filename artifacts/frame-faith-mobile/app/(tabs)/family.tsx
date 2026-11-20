import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListStudioChildProfilesQueryKey,
  useCreateStudioChildProfile,
  useDeleteStudioChildProfile,
  useListStudioChildProfiles,
  useUpdateStudioChildProfile,
  type ChildProfile,
  type ChildProfileAgeBand,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Button, Chip, EmptyState, FieldLabel, Notice, ScreenHeader, fonts } from '@/components/ui';
import { confirmAction } from '@/lib/confirm';

const ageBands: Array<{ value: ChildProfileAgeBand; label: string }> = [
  { value: '5-8', label: '5–8' },
  { value: '9-12', label: '9–12' },
  { value: '13-17', label: '13–17' },
];

function getErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = error.data;
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error;
  }
  return error instanceof Error ? error.message : 'The profile could not be saved. Please try again.';
}

export default function FamilyScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const profiles = useListStudioChildProfiles();
  const createProfile = useCreateStudioChildProfile();
  const updateProfile = useUpdateStudioChildProfile();
  const deleteProfile = useDeleteStudioChildProfile();
  const [editing, setEditing] = useState<ChildProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [ageBand, setAgeBand] = useState<ChildProfileAgeBand>('9-12');
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = createProfile.isPending || updateProfile.isPending || deleteProfile.isPending;

  function resetForm() {
    setEditing(null);
    setDisplayName('');
    setAgeBand('9-12');
    setGuardianConsent(false);
  }

  function editProfile(profile: ChildProfile) {
    setEditing(profile);
    setDisplayName(profile.displayName);
    setAgeBand(profile.ageBand);
    setGuardianConsent(false);
    setError('');
    setMessage('');
  }

  async function refreshProfiles() {
    await queryClient.invalidateQueries({ queryKey: getListStudioChildProfilesQueryKey() });
  }

  async function saveProfile() {
    setError('');
    setMessage('');
    try {
      if (editing) {
        await updateProfile.mutateAsync({ id: editing.id, data: { displayName: displayName.trim(), ageBand } });
        setMessage('Profile updated.');
      } else {
        if (!guardianConsent) return;
        await createProfile.mutateAsync({
          data: { displayName: displayName.trim(), ageBand, guardianConsent: true },
        });
        setMessage('Supervised profile created under your guardian account.');
      }
      resetForm();
      await refreshProfiles();
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }

  async function changeStatus(profile: ChildProfile) {
    setError('');
    setMessage('');
    try {
      const nextStatus = profile.status === 'active' ? 'paused' : 'active';
      await updateProfile.mutateAsync({ id: profile.id, data: { status: nextStatus } });
      await refreshProfiles();
      setMessage(nextStatus === 'paused' ? 'Profile paused.' : 'Profile resumed.');
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }

  async function confirmDelete(profile: ChildProfile) {
    const confirmed = await confirmAction({
      title: 'Remove child profile?',
      message: `Remove ${profile.displayName}’s profile? Studio work is not deleted. The profile has no separate login.`,
      confirmLabel: 'Remove profile',
      cancelLabel: 'Keep profile',
      destructive: true,
    });
    if (!confirmed) return;
    setError('');
    setMessage('');
    try {
      await deleteProfile.mutateAsync({ id: profile.id });
      if (editing?.id === profile.id) resetForm();
      await refreshProfiles();
      setMessage('Child profile removed.');
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }

  return (
    <KeyboardAwareScrollViewCompat screen>
      <ScreenHeader kicker="GUARDIAN CONTROLS" title="Child profiles" subtitle="Create and manage supervised profiles from your adult account." />

      <View style={[styles.privacyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardHeading, { color: colors.foreground }]}>Before creating or using a profile</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>We store a nickname and age range only—not a date of birth, child email, or password. A profile is a record only, not a separate sign-in or a way to open studio work. Studio access stays under your guardian account.</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>Child-safe mode stays on. Do not include identifying details in prompts or uploads. Age and parental-consent rules vary by location; this notice is not legal advice or a compliance certification.</Text>
      </View>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Text accessibilityRole="header" style={[styles.section, { color: colors.foreground }]}>Your profiles</Text>
      {profiles.isLoading ? <Text style={[styles.body, { color: colors.mutedForeground }]}>Loading profiles…</Text> : null}
      {profiles.isError ? <View style={styles.gap}>
        <Notice tone="error">{getErrorMessage(profiles.error)}</Notice>
        <Button variant="secondary" label="Try again" loading={profiles.isFetching} onPress={() => void profiles.refetch()} testID="mobile-retry-child-profiles" />
      </View> : null}
      {profiles.data?.length === 0 ? <EmptyState title="No child profiles yet" body="Add a supervised profile below. Only a nickname and age range are stored." /> : null}
      {profiles.data?.map((profile) => (
        <View key={profile.id} style={[styles.profileCard, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`mobile-child-profile-${profile.id}`}>
          <View style={styles.profileIdentity}>
            <View style={[styles.avatar, { backgroundColor: colors.secondary }]}><Text style={[styles.avatarText, { color: colors.foreground }]}>{profile.displayName.slice(0, 1).toUpperCase()}</Text></View>
            <View style={styles.profileDetails}>
              <Text style={[styles.cardHeading, { color: colors.foreground }]}>{profile.displayName}</Text>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>Ages {profile.ageBand} · {profile.status === 'active' ? 'Managed' : 'Paused'}</Text>
              <Text style={[styles.setting, { color: colors.teal }]}>Child-safe mode on · guardian approval recorded</Text>
            </View>
          </View>
          <View style={styles.actions}>
            <Button compact variant="secondary" label="Edit" accessibilityLabel={`Edit ${profile.displayName}`} onPress={() => editProfile(profile)} disabled={pending} testID={`mobile-edit-child-profile-${profile.id}`} />
            <Button compact variant="secondary" label={profile.status === 'active' ? 'Pause' : 'Resume'} accessibilityLabel={`${profile.status === 'active' ? 'Pause' : 'Resume'} ${profile.displayName}`} onPress={() => void changeStatus(profile)} disabled={pending} testID={`mobile-toggle-child-profile-${profile.id}`} />
            <Button compact variant="danger" label="Remove" accessibilityLabel={`Remove ${profile.displayName}`} onPress={() => void confirmDelete(profile)} disabled={pending} testID={`mobile-delete-child-profile-${profile.id}`} />
          </View>
        </View>
      ))}

      <View style={[styles.formCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardHeading, { color: colors.foreground }]}>{editing ? `Edit ${editing.displayName}` : 'Add a child profile'}</Text>
        <FieldLabel hint="Use a nickname, not a full name.">Nickname</FieldLabel>
        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={40}
          autoComplete="off"
          placeholder="A nickname, not a full name"
          placeholderTextColor={colors.mutedForeground}
          style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
          accessibilityLabel="Child profile nickname"
          testID="mobile-child-profile-name"
        />
        <FieldLabel hint="Stories and checks are tuned to this range.">Age range</FieldLabel>
        <View style={styles.ageOptions}>
          {ageBands.map((band) => {
            const selected = ageBand === band.value;
            return <Chip
              key={band.value}
              grow
              selected={selected}
              onPress={() => setAgeBand(band.value)}
              label={`Ages ${band.label}`}
              testID={`mobile-child-age-${band.value}`}
            />;
          })}
        </View>
        {!editing ? <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: guardianConsent }}
          onPress={() => setGuardianConsent(value => !value)}
          style={styles.consentRow}
          testID="mobile-child-profile-consent"
        >
          <View style={[styles.checkbox, { borderColor: guardianConsent ? colors.teal : colors.border, backgroundColor: guardianConsent ? colors.teal : 'transparent' }]}>
            {guardianConsent ? <Text style={{ color: colors.card, fontWeight: '700' }}>✓</Text> : null}
          </View>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>I am the child’s parent, guardian, or authorized caregiver; I have read this notice and have permission to create this supervised profile.</Text>
        </Pressable> : null}
        <View style={[styles.settingCard, { backgroundColor: colors.background }]}>
          <Text style={[styles.setting, { color: colors.teal }]}>Saved child-safe setting: On</Text>
          <Text style={[styles.caption, { color: colors.mutedForeground }]}>It is locked on for child profiles.</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
          {editing ? <View style={{ flex: 1 }}><Button variant="secondary" label="Cancel edit" onPress={resetForm} /></View> : null}
          <View style={{ flex: 1 }}>
            <Button
              onPress={() => void saveProfile()}
              disabled={!displayName.trim() || (!editing && !guardianConsent)}
              loading={pending}
              testID="mobile-save-child-profile"
              label={pending ? 'Saving…' : editing ? 'Save changes' : 'Create supervised profile'}
            />
          </View>
        </View>
        {!editing && !guardianConsent ? <Text style={[styles.caption, { color: colors.mutedForeground }]}>Confirm the guardian statement above to create a profile.</Text> : null}
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 110, gap: 12 },
  kicker: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  title: { fontFamily: 'Fraunces_600SemiBold', fontSize: 29, marginBottom: 2 },
  body: { fontFamily: 'Manrope_400Regular', fontSize: 14, lineHeight: 21 },
  privacyCard: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 9, marginTop: 4 },
  cardHeading: { fontFamily: fonts.bold, fontSize: 16 },
  section: { fontFamily: fonts.serif, fontSize: 22, marginTop: 10 },
  profileCard: { borderWidth: 1, borderRadius: 16, padding: 15, gap: 12 },
  profileIdentity: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { height: 42, width: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 18, fontWeight: '700' },
  profileDetails: { flex: 1, gap: 3 },
  setting: { fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingTop: 3, flexWrap: 'wrap' },
  formCard: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 11, marginTop: 6 },
  label: { fontSize: 13, fontWeight: '700', marginTop: 3 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontFamily: 'Manrope_400Regular', fontSize: 15 },
  ageOptions: { flexDirection: 'row', gap: 8 },
  ageOption: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 5 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 6 },
  checkbox: { width: 22, height: 22, borderWidth: 1, borderRadius: 5, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  settingCard: { padding: 11, borderRadius: 10, gap: 3 },
  caption: { fontFamily: 'Manrope_400Regular', fontSize: 12 },
  saveButton: { minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, marginTop: 4 },
  saveText: { fontFamily: 'Manrope_700Bold', fontSize: 14 },
  cancelButton: { alignSelf: 'flex-end', padding: 8 },
  error: { fontSize: 13, fontWeight: '600' },
  success: { fontSize: 13, fontWeight: '600' },
  gap: { gap: 8 },
});
