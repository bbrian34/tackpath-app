begin;
alter function operations.verify_package_integrity() security definer;
alter function operations.verify_manifest_balance() security definer;
alter function operations.verify_bin_release() security definer;
commit;
