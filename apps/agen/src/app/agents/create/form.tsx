"use client";

/**
 * Creating an agent, in the room it will be made in.
 *
 * The behaviour here is the one that was already shipped and proven on mainnet: the same
 * `POST /api/v1/owner/agents` with the same body, the same client-side rules mirroring
 * the server's, and the same owner session obtained by signing a challenge. The server
 * generates the wallet, encrypts the key and writes the permission row exactly as it did
 * before — none of that was touched, and none of it should be.
 *
 * What is new is the surface: a wider form on black, and a page that answers while it is
 * being filled in rather than only when it is submitted.
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Wallet } from "../../wallet";
import { useOwner } from "../owner";
import { Arrow } from "../ui";

/** A decimal amount of ETH as wei, or null when it is not an amount at all. */
function toWei(input: string): bigint | null {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > 18) return null;
  return BigInt(`${whole === "" ? "0" : whole}${frac.padEnd(18, "0")}`);
}

/** The handle rules, applied to anything: what is left of it that a handle may contain. */
function toHandle(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

export function CreateForm() {
  const router = useRouter();
  const owner = useOwner();

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [maxPerLaunch, setMaxPerLaunch] = useState("0.05");
  const [maxPerDay, setMaxPerDay] = useState("0.15");
  const [maxLaunches, setMaxLaunches] = useState("3");
  const [instant, setInstant] = useState(true);
  const [programmable, setProgrammable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The handle follows the name until somebody disagrees with it.
   *
   * Almost every agent's handle is its name in lowercase, and typing it twice is a chore
   * that also invites the two to drift apart. Once the field has been edited by hand it
   * stops following, because at that point the reader has said what they want and a form
   * that keeps overwriting them is worse than one that never helped.
   */
  const chosen = useRef(false);

  if (owner.phase === "connecting") {
    return <p className="ag-make-note">looking for your wallet…</p>;
  }

  if (owner.phase === "disconnected") {
    return (
      <Doorway
        lead="Connect a wallet."
        body="It becomes the only address that can control this agent."
      >
        <Wallet />
      </Doorway>
    );
  }

  if (owner.phase === "unsigned" || owner.phase === "signing" || owner.phase === "loading") {
    return (
      <Doorway
        lead="Sign in to create an agent."
        body="One signature, nothing spent, valid for as long as this tab stays open."
      >
        <button
          type="button"
          className="ag-go"
          disabled={owner.phase !== "unsigned"}
          onClick={() => void owner.signIn()}
        >
          {owner.phase === "unsigned" ? "Sign in" : "working…"}
          {owner.phase === "unsigned" ? <Arrow /> : null}
        </button>
        {owner.error === null ? null : <p className="ag-note ag-note-bad">{owner.error}</p>}
      </Doorway>
    );
  }

  const perLaunch = toWei(maxPerLaunch);
  const perDay = toWei(maxPerDay);
  const launches = Number(maxLaunches);

  const problems: string[] = [];
  if (name.trim() === "") problems.push("Give the agent a name.");
  else if (name.trim().length > 64) problems.push("A name is at most 64 characters.");
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    problems.push("A handle is 3–20 characters of lowercase letters, numbers or underscores.");
  }
  if (!instant && !programmable) problems.push("Let the agent create at least one kind of market.");
  if (perLaunch === null) problems.push("The per-launch limit is not an amount.");
  if (perDay === null) problems.push("The daily budget is not an amount.");
  if (perLaunch !== null && perDay !== null && perLaunch > perDay) {
    problems.push("The per-launch limit cannot exceed the daily budget.");
  }
  if (!Number.isInteger(launches) || launches < 0) {
    problems.push("Launches per day must be a whole number.");
  }

  const create = async () => {
    if (perLaunch === null || perDay === null) return;
    setError(null);
    setBusy(true);
    try {
      await owner.call("/api/v1/owner/agents", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          username,
          description: description.trim(),
          imageUrl,
          permissions: {
            instantAllowed: instant,
            programmableAllowed: programmable,
            maxEthPerLaunchWei: perLaunch.toString(),
            maxEthPerDayWei: perDay.toString(),
            maxCreatorBuyWei: perLaunch.toString(),
            maxLaunchesPerDay: launches,
          },
        }),
      });
      await owner.refresh();
      router.push(`/agents/@${username}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create that agent.");
      setBusy(false);
    }
  };

  // The button says what it is about to make, by name, as the name is typed.
  const named = name.trim();
  const commit = busy
    ? "Creating…"
    : named === ""
      ? "Create agent"
      : `Create agent ${named}`;

  return (
    <form
      className="ag-form"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="ag-pair">
        <label className="ag-field" htmlFor="ag-name">
          <span>Name</span>
          <input
            id="ag-name"
            value={name}
            maxLength={64}
            placeholder="Atlas"
            autoComplete="off"
            onChange={(event) => {
              const next = event.currentTarget.value;
              setName(next);
              if (!chosen.current) setUsername(toHandle(next));
            }}
          />
        </label>

        <label className="ag-field" htmlFor="ag-handle">
          <span>Handle</span>
          <input
            id="ag-handle"
            value={username}
            maxLength={20}
            placeholder="atlas"
            autoComplete="off"
            onChange={(event) => {
              chosen.current = true;
              setUsername(toHandle(event.currentTarget.value));
            }}
          />
        </label>
      </div>

      <label className="ag-field" htmlFor="ag-desc">
        <span>Description</span>
        <textarea
          id="ag-desc"
          value={description}
          rows={3}
          maxLength={280}
          placeholder="What this agent creates, and why."
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>

      <div className="ag-make-split">
        <div className="ag-field">
          <span>Image</span>
          <ImageField value={imageUrl} onChange={setImageUrl} />
        </div>

        <div className="ag-field">
          <span>May create</span>
          <label className="ag-check" htmlFor="ag-instant">
            <input
              id="ag-instant"
              type="checkbox"
              checked={instant}
              onChange={(event) => setInstant(event.currentTarget.checked)}
            />
            Instant v4 markets
          </label>
          <label className="ag-check" htmlFor="ag-prog">
            <input
              id="ag-prog"
              type="checkbox"
              checked={programmable}
              onChange={(event) => setProgrammable(event.currentTarget.checked)}
            />
            Programmable v4 markets
          </label>
        </div>
      </div>

      <p className="ag-hint">
        An agent can never move funds out of its own wallet and can only call agen.space
        contracts. These limits bound what it may spend inside that.
      </p>

      <div className="ag-trio">
        <label className="ag-field ag-amount" htmlFor="ag-per-launch">
          <span>Max / launch</span>
          <input
            id="ag-per-launch"
            value={maxPerLaunch}
            inputMode="decimal"
            placeholder="0.05"
            autoComplete="off"
            onChange={(event) => setMaxPerLaunch(event.currentTarget.value)}
          />
          <Ether />
        </label>

        <label className="ag-field ag-amount" htmlFor="ag-per-day">
          <span>Max / day</span>
          <input
            id="ag-per-day"
            value={maxPerDay}
            inputMode="decimal"
            placeholder="0.15"
            autoComplete="off"
            onChange={(event) => setMaxPerDay(event.currentTarget.value)}
          />
          <Ether />
        </label>

        <label className="ag-field" htmlFor="ag-launches">
          <span>Launches / day</span>
          <input
            id="ag-launches"
            value={maxLaunches}
            inputMode="numeric"
            placeholder="3"
            autoComplete="off"
            onChange={(event) => setMaxLaunches(event.currentTarget.value.replace(/[^0-9]/g, ""))}
          />
        </label>
      </div>

      <button
        className="ag-go ag-make-commit"
        type="submit"
        disabled={busy || problems.length > 0}
      >
        {commit}
      </button>

      {error !== null ? (
        <p className="ag-note ag-note-bad">{error}</p>
      ) : problems.length > 0 ? (
        <p className="ag-note">{problems[0]}</p>
      ) : null}
    </form>
  );
}

/** The unit mark that sits in the amount fields, so the number does not have to say it. */
function Ether() {
  return (
    <i className="ag-unit" aria-hidden="true">
      <svg viewBox="0 0 9 14" fill="currentColor">
        <path d="M4.5 0 0 7.3l4.5 2.6L9 7.3z" opacity="0.85" />
        <path d="M4.5 10.8 0 8.2l4.5 5.8L9 8.2z" />
      </svg>
    </i>
  );
}

/**
 * The picture, uploaded on choice rather than on submit — same `/api/images` endpoint and
 * same content-addressed answer the launch screens use, so an agent's image is stored the
 * way a token's is.
 */
function ImageField({
  value,
  onChange,
}: {
  readonly value: string | null;
  readonly onChange: (url: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/images", {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || typeof body.url !== "string") {
        setError(body.error ?? "That image could not be saved.");
        onChange(null);
        return;
      }
      onChange(body.url);
    } catch {
      setError("That image could not be saved.");
      onChange(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="ag-upload" onClick={() => input.current?.click()}>
        <i>
          {value === null ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="4" />
              <circle cx="8.8" cy="9.6" r="1.5" />
              <path d="M3.4 16.6 8.5 12l4 3.4 3.4-2.6 4.7 3.9" strokeLinejoin="round" />
            </svg>
          ) : (
            <img src={value} alt="" />
          )}
        </i>
        {busy ? "uploading…" : value === null ? "Upload image" : "Change image"}
      </button>

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) void take(file);
        }}
      />

      {error === null ? null : <p className="ag-hint">{error}</p>}
    </>
  );
}

/** What stands in for the form until there is a wallet, and then a signature, to make with. */
function Doorway({
  lead,
  body,
  children,
}: {
  readonly lead: string;
  readonly body: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="ag-make-wait">
      <p className="ag-make-lead">{lead}</p>
      <p className="ag-make-sub">{body}</p>
      <div className="ag-make-acts">{children}</div>
    </div>
  );
}
