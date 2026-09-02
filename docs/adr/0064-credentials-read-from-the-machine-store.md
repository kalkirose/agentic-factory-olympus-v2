# ADR-0064: The harness reads a credential from the machine, at the moment it uses it

Status: accepted (2026-09-02)

## The condition

The harness needs the credentials of outside services. A payment provider's
key, a forge token, a content API key: each one is named in the project config,
each one has a read-only probe, and each one is asked at the two gates where
the next step costs money.

The values live on the machine. The harness did not read them from there. A
daemon inherits a copy of the environment from the window that started it, and
that window took its own copy when it opened. A value that changed after either
copy was taken is invisible to the daemon for the life of the process. Every
probe, every seat and every suite then reads the stale copy.

The failure is silent. The harness recorded nothing about which copy it held,
so a refused probe said only that a value did not work. It did not say whether
the machine holds the right value and the service refuses it, or whether the
machine holds a value the daemon never saw. The two have opposite repairs. One
is answered at the service, the other on the host.

A restart after every credential change is not an answer. It depends on a
person to remember, and a person who forgets loses a story at its launch gate
with a park that names the wrong cause.

## Decision

**The instance names where this host keeps its credentials.** `instance.json`
takes `credentialStore`. `{"kind": "windows-user-env"}` reads the current
user's stored environment. `{"kind": "env-file", "path": <absolute>}` reads a
dotenv-style file, which is the kind a Linux host, CI and the unit tests use.
The field is optional. A home that names no store inherits its window's copy,
which is the behaviour every home had before the field existed, and it stamps
none of the records below.

**The Windows kind is read with `reg.exe`, one variable per query.** The values
sit under `HKCU\Environment`. `REG_SZ` and `REG_EXPAND_SZ` are both read, and
an expandable value has its references filled in. The value field runs to the
end of its line, so a value that ends in a space keeps that space. PowerShell
is not in this path. PS 5.1 appends a CRLF to a piped value, and it has
corrupted exact-byte values before.

**Only the declared variables are read.** The list is every `credentials[].env`
of every registered project's config. A store read is a read of somebody's
password, and the project's own declaration is the whole list of the ones this
harness has business with. A declared name the store does not hold falls back
to the inherited copy, and the fallback is recorded rather than silent.

**The store is read at use, never at start.** One function returns the fresh
values, and it is merged last into the environment at every place the harness
hands an environment to something that needs a credential: the credential gate
and its probes, and `runEnv`, which is what every project-config command, every
suite run and every seat of a run is given. A daemon that has run for a week
and a daemon started ten seconds ago read the same value.

**The daemon's own `process.env` is never written.** The fresh values ride the
merged environment of each spawn. The seat strip then decides who may hold
them, exactly as it decides for every other secret name: the seat that executes
the project's suite keeps them, and a seat that runs no suite loses them with
the rest. A stripped seat cannot reach one through the parent, because the
parent never held it.

**Every read leaves a fingerprint, never a value.** A fingerprint is the first
twelve hex characters of the SHA-256 of the value. It identifies a value. It
does not reveal one, and it does not report a length. Two reads of one password
read as one value, which is correct.

**The records are three.** `credential-fingerprints` is stamped at the start,
per project, and names each declared variable with its source (`store`,
`inherited` or `absent`) and its fingerprint. It is stamped again the first time
a gate reads a name no record covers, so a host whose clone arrived after the
start still has a baseline. `credential-rotated` is stamped when a later read
finds a fingerprint that differs from the last recorded one. It is quiet, and
it says a value changed on this host and when the harness first saw it.
`credential-probe` carries the fingerprint of the value it asked about, so a
refusal is tied to the exact value the service refused.

**A refused probe says which of the two failures it is.** The park reads the
last probe of that variable that answered yes, over every run of the project.
An unchanged fingerprint reads as "the stored value is unchanged since it last
passed on <date>; the service now refuses it; the credential itself needs
replacing". A changed one reads as "the stored value changed since it last
passed on <date>; the new value is refused; check the value placed on this
host". Before the first recorded pass the park says what it always said. The
options stay `retry` and `abandon`, and nothing here writes a secret anywhere.

**`olympusctl status` names the store.** One line under the daemon line carries
the store kind and, per project, how many declared variables came from the
store, how many fell back to the inherited copy, and how many nothing holds. A
count above zero under `inherited` is a daemon working from a copy the machine
can no longer confirm, and it is readable before a story tries the door.

## Why the store and not a copy at start

Copying the store into the daemon's environment once at start was rejected. It
removes one incident and keeps the class. A value that changes after the start
is invisible until the next restart, which is the condition this decision
exists to end.

A daemon-side vault was rejected. It adds a store to maintain where the machine
already has one, and the owner's own placement chain already puts values there.
Two stores need a rule for which one is right, and that rule is the next silent
failure.

Reading the store through PowerShell was rejected. The exact bytes matter, and
PS 5.1 has changed them before.

## Why a fingerprint and not a length or a prefix

A length reports a fact about the secret. A prefix reports part of the secret.
A fingerprint reports neither, and it answers the one question a reader has:
is this the value that passed last time. It is written to the ledgers, which
are read by people and by seats, so it must be safe to carry off this machine.

## Why the strip stays where it is

The seat strip is the rule that keeps a credential away from a throwaway
adversary tree and a read-only review seat. A fresh value is a credential like
any other, so it meets that rule rather than a new one. The alternative, a
separate path that hands stored values to seats directly, would give the host's
secrets a second route out and two rules to keep in step.

## Fallback paths

If a store kind proves wrong for a host, the fallback is to omit
`credentialStore` and inherit as before. It is one field. Every read returns an
empty set without it, every merge adds nothing, and no new record is written.
Trigger: a store read that answers wrongly on a host, or a probe that fails only
with the store named. Reversal cost: low. Delete the field and restart. Nothing
in the project configs, the gate forms or the stage semantics refers to it.

If reading the registry per variable proves slow on a host with many
credentials, the fallback is one query of the whole key per read pass, with the
declared names picked out of the answer. Trigger: a measurable cost at a gate
or a stage boundary. Reversal cost: low. It is one function, and the values it
returns are the same.

If a per-use read proves too frequent for a store that is expensive to reach,
the fallback is a read with a short lifetime, bounded in seconds rather than in
process lifetime. Trigger: a store kind whose read costs more than a probe.
Reversal cost: medium. A cached value can be stale for the length of the cache,
so the lifetime becomes a value somebody has to defend, and `credential-rotated`
becomes late by that much.
