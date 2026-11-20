import { useRef, useState } from 'react';
import { useDialogBehavior } from './Dialog';
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
import { Save, ShieldCheck, UserRoundPlus, X } from 'lucide-react';

type ProfileForm = { displayName: string; ageBand: ChildProfileAgeBand };
const emptyForm: ProfileForm = { displayName: '', ageBand: '9-12' };
const ageBands: Array<{ value: ChildProfileAgeBand; label: string }> = [
  { value: '5-8', label: 'Ages 5–8' },
  { value: '9-12', label: 'Ages 9–12' },
  { value: '13-17', label: 'Ages 13–17' },
];

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = error.data;
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error;
  }
  return error instanceof Error ? error.message : 'The profile could not be saved. Please try again.';
}

export function ChildProfilesPanel({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogBehavior(dialogRef, onClose, { initialFocus: 'dialog' });
  const queryClient = useQueryClient();
  const profiles = useListStudioChildProfiles();
  const createProfile = useCreateStudioChildProfile();
  const updateProfile = useUpdateStudioChildProfile();
  const deleteProfile = useDeleteStudioChildProfile();
  const [editing, setEditing] = useState<ChildProfile | null>(null);
  const [form, setForm] = useState<ProfileForm>(emptyForm);
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const pending = createProfile.isPending || updateProfile.isPending || deleteProfile.isPending;

  function startCreate() {
    setEditing(null);
    setForm(emptyForm);
    setGuardianConsent(false);
    setError('');
    setNotice('');
  }

  function startEdit(profile: ChildProfile) {
    setEditing(profile);
    setForm({ displayName: profile.displayName, ageBand: profile.ageBand });
    setGuardianConsent(false);
    setError('');
    setNotice('');
  }

  async function refreshProfiles() {
    await queryClient.invalidateQueries({ queryKey: getListStudioChildProfilesQueryKey() });
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      if (editing) {
        await updateProfile.mutateAsync({
          id: editing.id,
          data: { displayName: form.displayName.trim(), ageBand: form.ageBand },
        });
        setNotice('Profile changes saved.');
      } else {
        if (!guardianConsent) return;
        await createProfile.mutateAsync({
          data: { displayName: form.displayName.trim(), ageBand: form.ageBand, guardianConsent: true },
        });
        setNotice('Child profile created under your guardian account.');
        setForm(emptyForm);
        setGuardianConsent(false);
      }
      setEditing(null);
      await refreshProfiles();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function toggleStatus(profile: ChildProfile) {
    setError('');
    setNotice('');
    try {
      await updateProfile.mutateAsync({
        id: profile.id,
        data: { status: profile.status === 'active' ? 'paused' : 'active' },
      });
      await refreshProfiles();
      setNotice(profile.status === 'active' ? 'Profile paused.' : 'Profile resumed.');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function removeProfile(profile: ChildProfile) {
    if (!window.confirm(`Remove ${profile.displayName}’s profile? This removes the profile only; it does not delete studio work.`)) return;
    setError('');
    setNotice('');
    try {
      await deleteProfile.mutateAsync({ id: profile.id });
      if (editing?.id === profile.id) setEditing(null);
      await refreshProfiles();
      setNotice('Child profile removed.');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} tabIndex={-1} className="modal guardian-profile-modal" role="dialog" aria-modal="true" aria-labelledby="guardian-controls-title" data-testid="panel-guardian-controls">
        <div className="modal-header">
          <div><p className="eyebrow"><ShieldCheck size={14} /> Guardian controls</p><h2 id="guardian-controls-title">Child profiles</h2></div>
          <button type="button" className="icon-button" aria-label="Close guardian controls" data-testid="button-close-guardian-controls" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="guardian-notice" role="note">
          <strong>Before you create or use a profile</strong>
          <p>Profiles store a nickname and age range only—no date of birth, child email, or password. A profile is a record only, not a separate sign-in or a way to open studio work. Studio access stays under your guardian account.</p>
          <p>Child-safe mode is always on for these profiles. Do not put identifying details in prompts or uploads. Age and parental-consent rules vary by location; this notice is not legal advice or a compliance certification.</p>
        </div>

        <div className="child-profile-toolbar">
          <div><strong>Your supervised profiles</strong><span>Only your guardian account can manage these records.</span></div>
          <button type="button" className="btn btn-primary" onClick={startCreate} data-testid="button-new-child-profile"><UserRoundPlus size={14} /> Add profile</button>
        </div>

        {error && <p className="field-error" role="alert" data-testid="guardian-profile-error">{error}</p>}
        {notice && <p className="guardian-profile-notice" role="status">{notice}</p>}
        {profiles.isPending ? <p>Loading your profiles…</p> : profiles.isError ? (
          <div className="guardian-profile-empty" role="alert">
            <p>{errorMessage(profiles.error)}</p>
            <button type="button" className="btn btn-quiet" onClick={() => void profiles.refetch()}>Try again</button>
          </div>
        ) : profiles.data?.length ? (
          <div className="child-profile-list">
            {profiles.data.map((profile) => (
              <article key={profile.id} className={`child-profile-card ${profile.status === 'paused' ? 'is-paused' : ''}`} data-testid={`child-profile-${profile.id}`}>
                <div className="child-profile-summary">
                  <div className="profile-avatar" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</div>
                  <div className="child-profile-copy">
                    <strong>{profile.displayName}</strong>
                    <span>{ageBands.find((band) => band.value === profile.ageBand)?.label} · {profile.status === 'active' ? 'Managed' : 'Paused'}</span>
                    <small><ShieldCheck size={12} /> Child-safe mode on · guardian approval recorded</small>
                  </div>
                </div>
                <div className="child-profile-actions">
                  <button type="button" className="btn btn-quiet" onClick={() => startEdit(profile)} data-testid={`button-edit-child-profile-${profile.id}`}>Edit</button>
                  <button type="button" className="btn btn-quiet" onClick={() => void toggleStatus(profile)} disabled={pending} data-testid={`button-toggle-child-profile-${profile.id}`}>{profile.status === 'active' ? 'Pause' : 'Resume'}</button>
                  <button type="button" className="btn btn-quiet danger-text" onClick={() => void removeProfile(profile)} disabled={pending} data-testid={`button-delete-child-profile-${profile.id}`}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="guardian-profile-empty"><strong>No child profiles yet</strong><p>Create a supervised profile with only a nickname and age range.</p></div>}

        <form className="child-profile-form" onSubmit={(event) => void saveProfile(event)} data-testid="form-child-profile">
          <div className="child-profile-form-heading">
            <div><p className="eyebrow">{editing ? 'Edit profile' : 'New profile'}</p><h3>{editing ? `Update ${editing.displayName}` : 'Add a child profile'}</h3></div>
            {editing && <button type="button" className="btn btn-quiet" onClick={startCreate}>Cancel edit</button>}
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="child-profile-name">Nickname</label>
              <input id="child-profile-name" autoComplete="off" maxLength={40} required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} data-testid="input-child-profile-name" />
            </div>
            <div className="field">
              <label htmlFor="child-profile-age">Age range</label>
              <select id="child-profile-age" value={form.ageBand} onChange={(event) => setForm({ ...form, ageBand: event.target.value as ChildProfileAgeBand })} data-testid="select-child-profile-age">
                {ageBands.map((band) => <option key={band.value} value={band.value}>{band.label}</option>)}
              </select>
            </div>
          </div>
          {!editing && <label className="guardian-consent-check">
            <input type="checkbox" checked={guardianConsent} onChange={(event) => setGuardianConsent(event.target.checked)} data-testid="checkbox-guardian-profile-consent" />
            <span>I am the child’s parent, guardian, or authorized caregiver, and I have read the privacy and age notice above and have permission to create this supervised profile.</span>
          </label>}
          <div className="guardian-profile-setting">
            <ShieldCheck size={16} />
            <div><strong>Saved child-safe setting: On</strong><span>It is locked on for child profiles.</span></div>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={pending || !form.displayName.trim() || (!editing && !guardianConsent)} data-testid="button-save-child-profile">
              <Save size={14} /> {pending ? 'Saving…' : editing ? 'Save changes' : 'Create supervised profile'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
