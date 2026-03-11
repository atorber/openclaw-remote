use crate::cli::traits::CliExec;
use crate::error::SdkError;

/// CLI doctor command wrapper.
pub struct DoctorCmd<'a, C: CliExec> {
    pub(crate) cli: &'a C,
}

/// Parameters for the doctor command.
#[derive(Debug, Clone, Default)]
pub struct DoctorParams {
    /// Run deep checks (probes gateway).
    pub deep: bool,
    /// Attempt auto-repair.
    pub repair: bool,
}

impl<'a, C: CliExec> DoctorCmd<'a, C> {
    /// Run the doctor command.
    pub async fn run(&self, params: DoctorParams) -> Result<serde_json::Value, SdkError> {
        let mut args = vec!["doctor"];
        if params.deep {
            args.push("--deep");
        }
        if params.repair {
            args.push("--fix");
        }
        self.cli.exec_json(&args).await
    }
}
