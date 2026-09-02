# Feedback cases

This directory contains product failures that have been deliberately promoted into regression knowledge.

A case belongs here only after:

1. the failure has been recorded from a real or synthetic run;
2. any user correction has been preserved in the append-only event history;
3. the implementation has a concrete regression test;
4. the promoted case names that test and the expected behavior it protects.

Do not hand-edit a promoted case to erase an earlier wrong diagnosis. Superseded diagnoses are useful evidence; a later `user_correction` event records why the accepted direction changed.

Use `node dist/feedback-cli.js promote ...` rather than copying JSON manually.
